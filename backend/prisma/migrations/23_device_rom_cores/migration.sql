-- The core each game was last seen saving with on a device
ALTER TABLE `Device` ADD COLUMN `romCores` JSON NULL;
