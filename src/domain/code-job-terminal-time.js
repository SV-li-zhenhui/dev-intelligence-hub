export function codeJobTerminalLifecycleAt(job) {
  // Binding the memory receipt advances updatedAt after the terminal transition.
  return job.execution.memoryProjection?.sourceUpdatedAt ?? job.updatedAt;
}
