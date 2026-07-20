// None of these may be reported when typo detection is on.
const a = setup.attack(1);              // assigned in world.ts
const b = State.variables.hp;           // created ONLY by a passage <<set>>
const c = settings.volume;              // created ONLY by SugarCube's Setting API
