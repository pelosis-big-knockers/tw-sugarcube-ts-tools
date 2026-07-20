// `hp` is a number solely because a passage does `<<set $hp to 100>>`.
// If passage assignments are not harvested, hp is `any` and this compiles —
// which is exactly how a vacuous test would pass.
const wrong: string = State.variables.hp;
