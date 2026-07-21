setup.attack = (power: number): number => power * 2;

// `$gold` exists only because a <<script>> payload assigns it, and it is a
// number only because that payload is analyzed as the code it is. This is
// deliberately the wrong type, so the finding proves the recovery happened.
const gold: string = State.variables.gold;
