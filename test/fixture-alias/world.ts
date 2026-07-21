// The pattern this fixture exists for: a container shortened into a local, then
// populated through the local.
setup.setupPlayer = (): void => {
  const sv = State.variables;
  sv.name = "Hero";
  sv.hp = 100;
};

// Aliases chain, and `setup` aliases the same way `State.variables` does.
const own = setup;
const alsoOwn = own;
alsoOwn.greet = (): string => "hi";

// A binding that merely shares the name is not the container: `fromShadow` must
// not become a story variable.
setup.decoy = (sv: { fromShadow?: number }): void => {
  sv.fromShadow = 1;
};
