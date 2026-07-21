// The load-bearing negatives. Each line here MUST be reported; a clean-file
// check alone would pass just as well with every member left `any`.

// `hp` is a number through the alias, so this is a type error rather than `any`.
const wrong: string = State.variables.hp;

// Shadowed in world.ts by a parameter of the same name, so it never became a
// story variable.
const never = State.variables.fromShadow;

// A `let` can be pointed at another object further down, so it is deliberately
// not an alias.
let loose = setup;
loose.fromLet = 1;
