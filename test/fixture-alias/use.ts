// Everything created through an alias must show up under the container's own
// name — correctly typed, and never as a typo.
const who: string = State.variables.name;
const health: number = State.variables.hp;
const greeting: string = setup.greet();
setup.setupPlayer();
