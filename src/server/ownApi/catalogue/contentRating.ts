/**
 * Whether a viewer's age limit admits an item: SQL for inside a visibility
 * check that already has the viewer and the item in scope.
 *
 * An episode or season is judged by its own rating if it has one and by its
 * series' otherwise, since boards rate shows rather than episodes. A
 * collection has no rating of its own and is always shown; each film in it is
 * judged on its own when the collection is opened. A title no board has rated
 * follows the viewer's own `allow_unrated_content`.
 *
 * Aliases are code-owned SQL identifiers, never request input.
 */
export function contentRatingAllowedSql(
  viewerAlias = "viewer",
  itemAlias = "item",
): string {
  return `(
    ${viewerAlias}.max_content_age IS NULL
    OR ${itemAlias}.kind = 'collection'
    OR COALESCE(
      seyirlik_rating_age(${itemAlias}.official_rating),
      (SELECT seyirlik_rating_age(rated_series.official_rating)
         FROM items rated_series WHERE rated_series.id = ${itemAlias}.series_id),
      CASE WHEN ${viewerAlias}.allow_unrated_content THEN 0 ELSE 1000 END
    ) <= ${viewerAlias}.max_content_age
  )`;
}
