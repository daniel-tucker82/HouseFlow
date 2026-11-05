const path = require('node:path').posix
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'

function ownedAppExecutable({ device, dataPath, bundle, identifier, executable }) {
  if (!new RegExp('^' + uuid + '$', 'i').test(device) ||
      !path.isAbsolute(dataPath) || !dataPath.endsWith(`/Devices/${device}/data`) ||
      !path.isAbsolute(bundle) || path.normalize(bundle) !== bundle ||
      identifier !== 'com.cyntch.app' || executable !== 'Cyntch') {
    throw new Error('Unexpected owned application identity or path.')
  }
  // Maestro's clearState reinstalls this same signed app with a timestamped
  // directory name. Its bundle identifier and executable remain unchanged.
  const relative = path.relative(dataPath, bundle)
  if (!new RegExp('^Containers/Bundle/Application/' + uuid + '/(?:Cyntch|com\\.cyntch\\.app-[0-9]+)\\.app$', 'i').test(relative)) {
    throw new Error('Application bundle is outside the owned simulator installation.')
  }
  return path.join(bundle, executable)
}
module.exports = { ownedAppExecutable }
