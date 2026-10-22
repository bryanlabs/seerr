import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBookQuotaColumns1777500000000 implements MigrationInterface {
  name = 'AddBookQuotaColumns1777500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD "audiobookQuotaLimit" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD "audiobookQuotaDays" integer`
    );
    await queryRunner.query(`ALTER TABLE "user" ADD "ebookQuotaLimit" integer`);
    await queryRunner.query(`ALTER TABLE "user" ADD "ebookQuotaDays" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "ebookQuotaDays"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "ebookQuotaLimit"`);
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "audiobookQuotaDays"`
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "audiobookQuotaLimit"`
    );
  }
}
