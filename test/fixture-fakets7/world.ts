setup.attack = (power: number): number => power * 2;
State.variables.hp = 100;
const dmg: number = setup.attack(State.variables.hp);
