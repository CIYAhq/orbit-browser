// Marks every document it runs in: Orbit's tests check it never runs in Orbit's own views or pages.
document.documentElement.dataset.orbitBroadExtension = location.protocol
