// The turn: which seat is to play now. The core keeps it at turn/ ({seat, lead}) for every game; a rules game
// from before the core turn may keep its own at mechanics/<id>/turn as {seat}, and the table reads that too. A
// mechanic's turn that is a bare number is left alone: it may be an index into an order, not a seat.

const RUNNING = ["running", "ready_to_end"];
const CHIME_KEY = "dionysus.turnChime";
const CHIME_HZ = 880;
const CHIME_SECONDS = 0.35;
const CHIME_VOLUME = 0.2;
// A fade cannot reach zero, so it ends at a volume too quiet to hear.
const CHIME_FLOOR = 0.001;

/**
 * The seat whose turn it is while a match runs.
 *
 * @param {object} state the view tree
 * @returns {number|null} the seat, or null when no match runs or the
 *   turn is no one's
 */
export function turnSeat(state) {
  const core = state?.turn?.seat;
  let ret = null;

  // The core turn, or else a mechanic's own, while the match runs.
  if (RUNNING.includes(state?.match?.status)) {
    if (typeof core === "number") {
      ret = core;
    } else {
      for (const mechanic of Object.values(state?.mechanics || {})) {
        if ((ret == null) && (typeof mechanic?.turn?.seat === "number")) {
          ret = mechanic.turn.seat;
        }
      }
    }
  }

  return ret;
}

/**
 * Whether the game keeps a turn players may pass by hand: it declares
 * turn in game.json.
 *
 * @param {object} declaration the game's declaration
 * @returns {boolean} whether it does
 */
export function keepsTurn(declaration) {
  return (declaration?.turn != null);
}

/**
 * Whether the turn has just come to the viewer: it is theirs now, and
 * was not before.
 *
 * @param {number|null} before the turn's seat before
 * @param {number|null} after the turn's seat now
 * @param {number|null} seat the viewer's seat
 * @returns {boolean} whether it has
 */
export function cameToMe(before, after, seat) {
  return ((seat != null) && (after === seat) && (before !== seat));
}

/**
 * Whether this browser chimes when the turn comes to the viewer. It is
 * off unless they turned it on.
 *
 * @returns {boolean} whether it does
 */
export function chimeIsOn() {
  let ret = false;

  try {
    ret = (localStorage.getItem(CHIME_KEY) === "1");
  } catch {
    // Storage is blocked: off.
    ret = false;
  }

  return ret;
}

/**
 * Turn the chime on or off, in this browser.
 *
 * @param {boolean} isOn whether it chimes
 */
export function setChime(isOn) {
  try {
    if (isOn) {
      localStorage.setItem(CHIME_KEY, "1");
    } else {
      localStorage.removeItem(CHIME_KEY);
    }
  } catch {
    // Storage is blocked: it lasts only as long as the page.
  }
}

/**
 * A short soft tone, made on the spot, so no sound file is needed.
 */
export function chime() {
  const Context = window.AudioContext || window.webkitAudioContext;
  let audio = null;
  let tone = null;
  let gain = null;

  // One tone that fades out. A browser with no audio stays quiet.
  if (Context != null) {
    audio = new Context();
    tone = audio.createOscillator();
    gain = audio.createGain();
    tone.frequency.value = CHIME_HZ;
    gain.gain.setValueAtTime(CHIME_VOLUME, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      CHIME_FLOOR,
      audio.currentTime + CHIME_SECONDS,
    );
    tone.connect(gain).connect(audio.destination);
    tone.start();
    tone.stop(audio.currentTime + CHIME_SECONDS);
    tone.onended = () => audio.close();
  }
}
