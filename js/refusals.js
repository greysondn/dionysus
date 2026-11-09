// Controls the game's rules would refuse. The server sends them disabled
// (enabled: false) with the rules' reason, instead of leaving them out, so
// the table still shows each button, greyed, and says why on hover and on
// a press. The table's End turn comes as a control too, anchored on
// "core:turn", which the turn line reads.

// Said when a control is disabled without a reason.
const NO_REASON = "That can't be done right now.";
// What End turn's control is anchored on.
const TURN_ANCHOR = "core:turn";

/**
 * Whether a control is offered disabled.
 *
 * @param {object|null|undefined} control the control
 * @returns {boolean} whether pressing it would be refused
 */
export function isRefused(control) {
  return (control?.enabled === false);
}

/**
 * What to tell the viewer about a disabled control: the rules' reason,
 * as a refused move's is told, or a plain line when there is none.
 *
 * @param {object|null|undefined} control the control
 * @returns {string} the reason
 */
export function refusalText(control) {
  const reason = control?.reason;
  let ret = NO_REASON;

  if ((typeof reason === "string") && (reason !== "")) {
    ret = reason;
  }

  return ret;
}

/**
 * End turn's control, among the viewer's controls.
 *
 * @param {Array<object>|null|undefined} controls the viewer's controls
 * @returns {object|null} the control, or null when there is none (a
 *   server from before it was sent, or a seat not offered End turn)
 */
export function endTurnControl(controls) {
  let ret = null;

  for (const control of controls || []) {
    if (
      (ret == null) &&
      (control.action_type === "turn.pass") &&
      (control.anchor === TURN_ANCHOR)
    ) {
      ret = control;
    }
  }

  return ret;
}

/**
 * The attributes that grey out a refused button and give it its reason
 * as a tooltip. The button is not made disabled outright: a disabled
 * button takes no clicks (and some browsers show it no tooltip), and a
 * press is how a touch screen asks why.
 *
 * @param {object} control the control
 * @returns {object} attributes for h(), empty for a live control
 */
export function refusedAttributes(control) {
  let ret = {};

  if (isRefused(control)) {
    ret = {
      "aria-disabled": "true",
      "data-refused": "",
      title: refusalText(control),
    };
  }

  return ret;
}
