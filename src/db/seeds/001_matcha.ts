import type { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  await knex('hashtags').insert({ name: 'matcha' }).onConflict('name').ignore();
}
