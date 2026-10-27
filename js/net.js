// The connection shell: a control channel (JSON) and a bulk channel (binary file frames), with requests, session
// resume, and reconnection. Two transports carry the channels:
//   * WebRTC data channels, set up by the out-of-band handshake: the host passes this client a challenge code, the
//     client answers with a response code, and the two sides find each other. This is how a client served from a
//     static HTTPS site (GitHub Pages) reaches a game server. Once in, the client holds a reconnect key and the
//     server's re-dial details, so after a drop it dials the server again on its own (redial(), and redial.py).
//   * Two WebSockets on the server's own origin, when the server serves this page itself.
// The client is dumb: when unsure, it resyncs.
import * as handshake from "./handshake.js";

const PROTOCOL = 1;
const GATHER_TIMEOUT_MS = 6000;
const ACCEPT_GRACE_MS = 30000;          // after the invite expires: time for a response entered at the last moment to connect
const REDIAL_TIMEOUT_MS = 10000;        // a re-dial that has not got in by then has failed

export class Net extends EventTarget {
  constructor() {
    super();
    this.mode = null;               // "websocket" or "webrtc"
    this.pending = new Map();
    this.nextId = 1;
    this.clientSeq = Date.now() % 1000000;
    this.welcome = null;
    this.frameHandlers = new Set();
    this.open = false;
    this.sendText = () => {};
    this.sendBulk = () => {};
    this.bulkBuffered = () => 0;
    this.closeTransport = () => {};
  }

  // ---------------------------------------------------------------- transports

  url(path) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}${path}`;
  }

  /** The server serves this page: two WebSockets on its origin. */
  connect() {
    this.mode = "websocket";
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url("/ws"));
      this.sendText = (text) => { if (ws.readyState === WebSocket.OPEN) ws.send(text); };
      this.closeTransport = () => ws.close();
      ws.onopen = () => this.hello();
      ws.onmessage = (ev) => this.onControl(ev.data, async () => {
        await this.openBulkSocket();
        return true;
      }).then((w) => w && resolve(w), reject);
      ws.onclose = () => this.onClosed();
      ws.onerror = () => reject(new Error("cannot reach the server"));
    });
  }

  openBulkSocket() {
    return new Promise((resolve, reject) => {
      const b = new WebSocket(this.url("/bulk"));
      b.binaryType = "arraybuffer";
      this.sendBulk = (bytes) => b.send(bytes);
      this.bulkBuffered = () => b.bufferedAmount;
      b.onopen = () => b.send(JSON.stringify({ connection_id: this.welcome.connection_id }));
      b.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          if (JSON.parse(ev.data).type === "bulk_ready") resolve();
          return;
        }
        for (const h of this.frameHandlers) h(new Uint8Array(ev.data));
      };
      b.onerror = () => reject(new Error("the bulk channel failed"));
    });
  }

  /**
   * Join with a challenge code from the host. Resolves once the response code is ready (show it to the player, who
   * passes it back to the host); `connected` resolves with the welcome once the host has entered it.
   */
  async answer(challengeCode, { name, stunServers, policy }) {
    const envelope = await handshake.decode(challengeCode, "c");
    if (envelope.exp && envelope.exp * 1000 < Date.now()) {
      throw new handshake.CodeError("That invite has expired. Ask the host for a new one.");
    }
    this.mode = "webrtc";
    // the challenge may carry the host's TURN server, with a credential for it, to relay through if nothing else works
    const relays = (Array.isArray(envelope.ice) ? envelope.ice : []).filter((s) =>
      [].concat(s?.urls || []).every((u) => typeof u === "string" && /^turns?:/.test(u)));
    // policy "relay" (the static site's config.json) connects only through the relay, so the host never learns our address
    const pc = new RTCPeerConnection({ iceServers: [...(stunServers || []).map((urls) => ({ urls })), ...relays],
                                       iceTransportPolicy: policy === "relay" && relays.length ? "relay" : "all" });
    this.pc = pc;
    const channels = {};
    let connectedResolve, connectedReject;
    const connected = new Promise((a, b) => { connectedResolve = a; connectedReject = b; });
    const maybeOpen = () => {
      if (channels.control?.readyState === "open" && channels.bulk?.readyState === "open" && !this.open) {
        this.hello();
      }
    };
    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      ch.binaryType = "arraybuffer";
      channels[ch.label] = ch;
      if (ch.label === "control") {
        this.sendText = (text) => { if (ch.readyState === "open") ch.send(text); };
        ch.onmessage = (e) => this.onControl(e.data, async () => true).then((w) => w && connectedResolve(w), connectedReject);
        ch.onclose = () => this.onClosed();
      } else if (ch.label === "bulk") {
        this.sendBulk = (bytes) => ch.send(bytes);
        this.bulkBuffered = () => ch.bufferedAmount;
        ch.onmessage = (e) => { for (const h of this.frameHandlers) h(new Uint8Array(e.data)); };
      }
      ch.onopen = maybeOpen;
      if (ch.readyState === "open") maybeOpen();
    };
    // Our checks start the moment the answer exists, but until the host enters the response the server's relay (or
    // its router) drops them, and the browser may call the connection failed. It recovers once the server starts
    // checking, so a failure counts only after the connection was up, or once the invite can no longer be accepted.
    let wasConnected = false;
    const giveUp = setTimeout(() => {
      connectedReject(new Error("The two sides could not reach each other. The host can create a new invite to try again."));
      pc.close();
    }, Math.max(0, (envelope.exp || 0) * 1000 - Date.now()) + ACCEPT_GRACE_MS);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected" && !wasConnected) {
        wasConnected = true;
        clearTimeout(giveUp);
      }
      if (pc.connectionState === "failed" && wasConnected) this.onClosed();
    };
    this.closeTransport = () => pc.close();
    await pc.setRemoteDescription({ type: "offer", sdp: envelope.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);           // use what was found, rather than wait forever
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") { clearTimeout(timer); resolve(); }
      });
    });
    const response = await handshake.encode("r", { v: handshake.VERSION, k: "r", id: envelope.id, sdp: pc.localDescription.sdp,
                                                   ...(name ? { name } : {}) });
    return { response, envelope, connected };
  }

  /**
   * Dial the server again from the details a reconnect key came with: no host, no codes. We write the server's half
   * of the handshake ourselves, and use an ICE username that is also our ICE password, which is how the server
   * learns it. The key goes first; a server that refuses it rejects with code "refused".
   */
  async redial(details, key, timeoutMs = REDIAL_TIMEOUT_MS) {
    this.mode = "webrtc";
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    const control = pc.createDataChannel("control", { negotiated: true, id: 0, ordered: true });
    const bulk = pc.createDataChannel("bulk", { negotiated: true, id: 1, ordered: true });
    control.binaryType = bulk.binaryType = "arraybuffer";
    const ice = hex(crypto.getRandomValues(new Uint8Array(12)));
    const offer = await pc.createOffer();
    await pc.setLocalDescription({ type: "offer", sdp: offer.sdp.replace(/a=ice-ufrag:.*\r\n/g, `a=ice-ufrag:${ice}\r\n`)
                                                         .replace(/a=ice-pwd:.*\r\n/g, `a=ice-pwd:${ice}\r\n`) });
    await pc.setRemoteDescription({ type: "answer", sdp: serverAnswer(details, (offer.sdp.match(/a=mid:(\S+)/) || [])[1] || "0") });
    this.sendText = (text) => { if (control.readyState === "open") control.send(text); };
    this.sendBulk = (bytes) => bulk.send(bytes);
    this.bulkBuffered = () => bulk.bufferedAmount;
    this.closeTransport = () => pc.close();
    bulk.onmessage = (e) => { for (const h of this.frameHandlers) h(new Uint8Array(e.data)); };
    return new Promise((resolve, reject) => {
      let settled = false, passed = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pc.close();
        reject(err);
      };
      const lost = () => (settled ? this.onClosed() : fail(new Error("The server closed the connection.")));
      const timer = setTimeout(() => fail(new Error("The server did not answer.")), timeoutMs);
      control.onopen = () => control.send(JSON.stringify({ type: "redial", key }));
      control.onmessage = (e) => {
        if (!passed) {
          const msg = JSON.parse(e.data);
          if (msg.type === "redial_ok") {
            passed = true;
            this.hello();
          } else if (msg.type === "redial_refused") {
            fail(Object.assign(new Error(msg.reason), { code: "refused" }));
          }
          return;
        }
        this.onControl(e.data, async () => true).then((w) => {
          if (w && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve(w);
          }
        }, fail);
      };
      control.onclose = lost;
      pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") lost(); };
    });
  }

  /** Show the server our reconnect key on a connection an invite made, so our session survives a new address. */
  presentKey(key) {
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(timer);
        this.removeEventListener("redial_ok", yes);
        this.removeEventListener("redial_refused", no);
        resolve(ok);
      };
      const yes = () => done(true), no = () => done(false);
      const timer = setTimeout(no, 5000);
      this.addEventListener("redial_ok", yes);
      this.addEventListener("redial_refused", no);
      this.send({ type: "redial", key });
    });
  }

  // ---------------------------------------------------------------- the protocol, the same on both

  hello() {
    this.sendText(JSON.stringify({ type: "hello", protocol: PROTOCOL, client: "dionysus-web", capabilities: ["bulk_socket", "invites"] }));
  }

  async onControl(data, afterWelcome) {
    const msg = JSON.parse(data);
    if (msg.type === "welcome") {
      this.welcome = msg;
      await afterWelcome();
      this.open = true;
      return msg;
    }
    if (msg.type === "response" && this.pending.has(msg.id)) {
      const { resolve: ok, reject: no } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.ok ? ok(msg.result) : no(Object.assign(new Error(msg.error?.message || msg.error?.code), { code: msg.error?.code }));
      return null;
    }
    this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
    this.dispatchEvent(new CustomEvent("message", { detail: msg }));
    return null;
  }

  onClosed() {
    const was = this.open;
    this.open = false;
    for (const { reject: no } of this.pending.values()) no(new Error("disconnected"));
    this.pending.clear();
    if (was) this.dispatchEvent(new CustomEvent("closed"));
  }

  close() {
    this.open = false;
    this.closeTransport();
  }

  send(msg) {
    this.sendText(JSON.stringify(msg));
  }

  request(method, params = {}) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: "request", id, method, params });
    });
  }

  action(tableId, actionType, params = {}, windowSeq) {
    const clientSeq = ++this.clientSeq;
    return new Promise((resolve) => {
      const onAck = (ev) => {
        if (ev.detail.client_seq === clientSeq) {
          this.removeEventListener("ack", onAck);
          resolve(ev.detail);
        }
      };
      this.addEventListener("ack", onAck);
      this.send({ type: "action", table_id: tableId, client_seq: clientSeq, action_type: actionType, params,
                  ...(windowSeq != null ? { window_seq: windowSeq } : {}) });
    });
  }

  sendBinary(bytes) {
    this.sendBulk(bytes);
  }

  get bufferedAmount() {
    return this.bulkBuffered();
  }
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The server's answer to a re-dial, written from its details (redial.py serves exactly this). */
function serverAnswer(d, mid) {
  const [ip, port] = d.cands[0];
  return ["v=0", "o=- 0 0 IN IP4 0.0.0.0", "s=-", "t=0 0", `a=group:BUNDLE ${mid}`,
    `m=application ${port} UDP/DTLS/SCTP webrtc-datachannel`, `c=IN IP4 ${ip}`, `a=mid:${mid}`,
    `a=ice-ufrag:${d.ufrag}`, `a=ice-pwd:${d.pwd}`, `a=fingerprint:sha-256 ${d.fp}`, "a=setup:passive",
    "a=sctp-port:5000", "a=max-message-size:65536",
    ...d.cands.map(([cip, cport], i) => `a=candidate:${i + 1} 1 udp ${2130706431 - i} ${cip} ${cport} typ host`),
    "a=end-of-candidates", ""].join("\r\n");
}
