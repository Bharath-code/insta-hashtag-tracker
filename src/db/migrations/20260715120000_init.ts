import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('hashtags', (t) => {
    t.increments('id').primary();
    t.text('name').notNullable().unique();
    t.text('meta_hashtag_id');
    t.timestamp('last_synced_at', { useTz: true });
    t.timestamps(true, true);
  });
  await knex.schema.createTable('media', (t) => {
    t.text('id').primary();
    t.integer('hashtag_id').notNullable().references('hashtags.id');
    t.text('caption');
    t.text('media_type').notNullable();
    t.text('permalink').notNullable();
    t.text('media_url');
    t.text('storage_key');
    t.integer('like_count').notNullable().defaultTo(0);
    t.integer('comments_count').notNullable().defaultTo(0);
    t.timestamp('posted_at', { useTz: true }).notNullable();
    t.text('source').notNullable();
    t.timestamps(true, true);
    t.index(['posted_at', 'id'], 'media_feed_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('media');
  await knex.schema.dropTable('hashtags');
}
