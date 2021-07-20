import { PermissionName } from '@standardnotes/auth'
import { ComponentArea } from '@standardnotes/snjs'
import { ContentType } from '@standardnotes/snjs'
import { DockIconType } from './DockIconType'
import { Flag } from './Flag'

export type Feature = {
  name: PermissionName;
  identifier: string;
  contentType: ContentType
  area: ComponentArea;
  layerable: boolean;
  noMobile: boolean;
  version: string;
  description: string;
  url: string;
  downloadUrl: string;
  marketingUrl: string;
  thumbnailUrl: string;
  flags: Flag[];
  dockIcon: {
    type: DockIconType;
    backgroundColor: string;
    foregroundColor: string;
    borderColor: string;
  };
  expiresAt: number;
};
