import { Global, Module } from '@nestjs/common';
import { LocalStorageService, StorageDriver } from './storage.service';

@Global()
@Module({
  providers: [{ provide: StorageDriver, useClass: LocalStorageService }],
  exports: [StorageDriver],
})
export class StorageModule {}
