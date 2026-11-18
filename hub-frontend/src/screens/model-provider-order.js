// Keep the model catalog predictable after a reload: a just-created provider
// stays on top, enabled services come before disabled ones, and custom
// services come before built-ins so users do not have to scroll past every
// system provider to reach their own configuration.
export function compareModelProviders(a, b, newProviderId = '') {
  return Number(b.id === newProviderId) - Number(a.id === newProviderId) ||
    (b.enabled - a.enabled) ||
    (a.builtin - b.builtin) ||
    a.name.localeCompare(b.name)
}
