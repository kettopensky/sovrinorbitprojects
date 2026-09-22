# SOVRIN Projects

The project map behind sovrinprojects.com. Every project sits on one of five
orbits, and can be browsed three ways: an orbit map, a list, and cards.

| Orbit | What goes there |
|---|---|
| 01 Passion Projects | Built because I wanted them to exist |
| 02 Digital Products | Tools and infrastructure, built and running |
| 03 My Own Sites | Brands and properties I run |
| 04 Client Work | Built and handed to the people who own them |
| 05 Services Offered | What you can hire me to build |

## Structure

```
public/
  index.html              the site (orbit, list and card views)
  project-media/          screenshots, generated from the vault
scripts/
  build-projects.mjs      Obsidian vault  ->  src/data/projects.json
src/data/
  projects.json           generated project data, never edited by hand
netlify.toml
```

## Running it

Open `public/index.html` in a browser. No install, no build step.

## Project data

Projects are written as notes in an Obsidian vault that lives outside this
repo. To regenerate the data:

```
node scripts/build-projects.mjs --vault "C:/path/to/vault"
```

Anything under a `## Private notes` heading, and any note marked
`public: false`, is left out of the output.

The vault is excluded in `.gitignore` on purpose: stripping private notes from
the JSON does nothing if the raw notes are committed alongside it.

## Status

- The page currently renders from data embedded in `index.html`. Switching it
  to read `src/data/projects.json` is the next step, which will let the vault
  drive the site directly.
- The original SOVRIN build lives in a separate repo, `sovrinprojects-site`,
  and is listed on the map as "SOVRIN First Build". Merging the two is planned.
