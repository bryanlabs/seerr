import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHardcoverWatchlistFields1777600000000 implements MigrationInterface {
  name = 'AddHardcoverWatchlistFields1777600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "hardcoverUsername" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "autoRequestAudiobooks" boolean`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "autoRequestEbooks" boolean`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "autoRequestEbooks"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "autoRequestAudiobooks"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "hardcoverUsername"`
    );
  }
}
