// A genuine typo alongside the compound-created members: `greet` exists,
// `greeet` does not. This must be caught — which also proves the container
// actually closed, so the "not a typo" checks aren't passing for the wrong reason.
const oops = setup.greeet();
