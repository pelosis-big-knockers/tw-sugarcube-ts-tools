setup.attack = (power: number): number => power * 2;
setup.playerName = (): string => "Ada";

// These two exist so their containers are CLOSABLE. Without at least one
// assignment a container is seeded "dynamic" and stays open no matter what,
// which would make every check below pass for the wrong reason.
State.variables.gold = 0;
settings.difficulty = "easy";
