import path from 'node:path';

// External sockets stay externally owned. A managed socket is launched by the
// original helper lifecycle, allowing isolated packages to coexist safely.
export function resolveHelperSocket(env, defaultPath) {
  const managed = env.PI_COMPUTER_USE_HELPER_SOCKET_PATH;
  if (managed !== undefined && (!path.isAbsolute(managed) || managed.includes('\0'))) {
    throw new Error('PI_COMPUTER_USE_HELPER_SOCKET_PATH must be an absolute path');
  }
  if (managed !== undefined && env.PI_CU_SOCKET_PATH !== undefined) {
    throw new Error('Managed and external helper sockets cannot both be configured');
  }
  const socketPath = env.PI_CU_SOCKET_PATH ?? managed ?? defaultPath;
  return { socketPath, external: env.PI_CU_SOCKET_PATH !== undefined && socketPath !== defaultPath };
}
