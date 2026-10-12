-- The core the firmware launches for each system, as the device reports it
ALTER TABLE `Device` ADD COLUMN `systemCores` JSON NULL;
