-- When a device first reported its current client version
ALTER TABLE `Device` ADD COLUMN `clientUpdatedAt` DATETIME(3) NULL;
