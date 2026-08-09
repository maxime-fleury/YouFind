export function createJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createProgressTracker(fields = {}) {
  return {
    total: 0,
    completed: 0,
    current: "",
    status: "idle",
    ...fields,
  };
}

export function resetProgressTracker(tracker, fields = {}) {
  Object.assign(tracker, {
    total: 0,
    completed: 0,
    current: "",
    status: "running",
    ...fields,
  });
  return tracker;
}
