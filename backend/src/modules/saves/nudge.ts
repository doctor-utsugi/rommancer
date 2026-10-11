import { prisma } from '../../lib/prisma.js';

/**
 * Devices told to sync their saves at their next poll (within seconds): a save another device just sent is
 * waiting for them. Kept in memory: after a restart the devices' regular passes catch up on their own.
 */
const waiting = new Set<number>();

/** Every device of USERID but EXCEPT (the one that sent the save) */
export async function nudgeDevices(userId: number, except?: number | null) {
  const devices = await prisma.device.findMany({ where: { userId }, select: { id: true } });
  for (const d of devices) if (d.id !== except) waiting.add(d.id);
}

/** Whether DEVICEID was nudged since it last asked; asking clears it */
export function takeNudge(deviceId: number) {
  return waiting.delete(deviceId);
}
