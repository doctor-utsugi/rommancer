-- Games a frontend on the device launches: their systems and emulator setups
ALTER TABLE `Device` ADD COLUMN `launcher` JSON NULL;
