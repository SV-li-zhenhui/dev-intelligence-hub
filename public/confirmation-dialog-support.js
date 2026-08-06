export function createConfirmationDialogOwnership() {
  let nextOwner = 0;
  let activeOwner = null;
  let submissionOwner = null;

  function isOwner(owner) {
    return Number.isSafeInteger(owner) && owner > 0;
  }

  function ownsSubmission(owner) {
    return (
      isOwner(owner) &&
      activeOwner === owner &&
      submissionOwner === owner
    );
  }

  function close(owner) {
    if (!isOwner(owner) || activeOwner !== owner) return false;
    activeOwner = null;
    if (submissionOwner === owner) submissionOwner = null;
    return true;
  }

  return Object.freeze({
    open() {
      activeOwner = ++nextOwner;
      submissionOwner = null;
      return activeOwner;
    },

    current() {
      return activeOwner;
    },

    ownsSubmission,

    beginSubmission(owner) {
      if (
        !isOwner(owner) ||
        activeOwner !== owner ||
        submissionOwner !== null
      ) {
        return false;
      }
      submissionOwner = owner;
      return true;
    },

    finishSubmission(owner) {
      if (!ownsSubmission(owner)) return false;
      submissionOwner = null;
      return true;
    },

    close,

    handleCloseEvent({ dialogOpen } = {}) {
      if (dialogOpen !== false || !isOwner(activeOwner)) return false;
      return close(activeOwner);
    },
  });
}
