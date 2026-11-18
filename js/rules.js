// The rules in force at a table, listed in words: the house rules (the
// game's variants) with what each one chosen means, and the expansions that
// are on. Read only, and open at any time, in the lobby or mid game. The
// listing is a pure function so it runs under Node too
// (tests/client/rules.test.mjs); the dialog is drawn by the table page.

/**
 * The house rules in force: each variant the game declares, with the
 * option the table has chosen (or the game's default where none is set).
 *
 * @param {Array<object>} variants the game's variant declarations
 * @param {object} settings the table's settings, by key
 * @returns {Array<{description: string, option: string,
 *     optionDescription: string, isDefault: boolean}>} the house rules,
 *     in the game's order; description and optionDescription are text keys
 */
export function houseRulesIn(variants, settings) {
    const ret = [];

    // Each variant, and the option chosen for it.
    for (const variant of (variants || [])) {
        const chosen = (settings || {})[`variants.${variant.key}`];
        const option = chosen ?? variant.default;
        const declared = (variant.options || [])
            .find((o) => (o.key === option));

        ret.push({
            description: variant.description,
            option: option,
            optionDescription: declared?.description ?? null,
            isDefault: (option === variant.default),
        });
    }

    return ret;
}

/**
 * The expansions that are on: each one offered whose setting names a
 * version rather than "off".
 *
 * @param {Array<object>} offered the game's expansion declarations
 * @param {object} settings the table's settings, by key
 * @returns {Array<{name: string, version: string, description: string}>}
 *     the expansions on, in the order offered; description is the
 *     expansion's own text where it sent one, else null
 */
export function expansionsOn(offered, settings) {
    const ret = [];

    // Each expansion offered, kept when it is on.
    for (const expansion of (offered || [])) {
        const chosen = (settings || {})[
            `expansions.${expansion.expansion_id}`
        ];

        if ((chosen !== undefined) && (chosen !== "off")) {
            ret.push({
                name: expansion.name,
                version: chosen,
                description: expansion.description_text ?? null,
            });
        }
    }

    return ret;
}
