import { Global, Module } from '@nestjs/common';
import { FirestoreService } from './firestore.service';

// Global: every module reads/writes the SAME Firestore that powers vcut-app.
// There is no second database — this service is the single data gateway.
@Global()
@Module({
  providers: [FirestoreService],
  exports: [FirestoreService],
})
export class FirestoreModule {}
