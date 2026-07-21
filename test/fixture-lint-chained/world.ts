// `makeHero` is itself a recovered member: it does not exist until the
// augmentation declares it. The passage below assigns from it, so the story
// variable's type is only knowable on a SECOND generation pass.
setup.makeHero = () => ({ name: "Ada", hp: 100 });
