import rackImage from '@/assets/images/dcim/rack.png';
import rackFrontPart from '@/assets/images/dcim/rack_front_part.png';
import rackRearPart from '@/assets/images/dcim/rack_rear_part.png';
import firewallFront from '@/assets/images/dcim/device/firewall_front.png';
import firewallRear from '@/assets/images/dcim/device/firewall_rear.png';
import raidFront from '@/assets/images/dcim/device/raid_front.png';
import raidRear from '@/assets/images/dcim/device/raid_rear.png';
import routerFront from '@/assets/images/dcim/device/router_front.png';
import routerRear from '@/assets/images/dcim/device/router_rear.png';
import serverFront from '@/assets/images/dcim/device/server_front.png';
import serverRear from '@/assets/images/dcim/device/server_rear.png';
import switchFront from '@/assets/images/dcim/device/switch_front.png';
import switchRear from '@/assets/images/dcim/device/switch_rear.png';

// The rack's product art, carried over from cantor's DCIM assets.
//
// A DATA CENTRE IS RECOGNISED BY ITS FRONT PANELS. A coloured block can say
// which unit a device occupies, but it cannot tell a switch from a server at a
// glance; the reference art can. The mapping is by CI TYPE NAME because that
// is what the model declares, and unknown device models fall back to a server
// face rather than an empty box.

export type RackFace = 'front' | 'rear';

const DEVICE_IMAGES: Record<string, { front: string; rear: string }> = {
  server: { front: serverFront, rear: serverRear },
  switch: { front: switchFront, rear: switchRear },
  fc_switch: { front: switchFront, rear: switchRear },
  bigip: { front: switchFront, rear: switchRear },
  f5: { front: switchFront, rear: switchRear },
  load_balance: { front: switchFront, rear: switchRear },
  router: { front: routerFront, rear: routerRear },
  firewall: { front: firewallFront, rear: firewallRear },
  raid: { front: raidFront, rear: raidRear },
};

export function deviceImage(typeName: string, face: RackFace): string {
  const mapping = DEVICE_IMAGES[typeName] ?? DEVICE_IMAGES.server;
  return mapping[face];
}

export { rackImage, rackFrontPart, rackRearPart };
