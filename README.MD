# Becklyn Contentful Migrations

A tool for managing content model migrations for Contentful. Inspired by the 
["Integrating migrations in a continuous delivery pipeline with CircleCI"](https://www.contentful.com/developers/docs/tutorials/general/continuous-integration-with-circleci/)
article and [Doctrine Migrations](https://github.com/doctrine/migrations), based on examples from  
[contentful-labs/continous-delivery-environments-example](https://github.com/contentful-labs/continous-delivery-environments-example). 

## Introduction

The tool can run migrations on both production-type environments which need to be stable and supporting rollbacks, as
well as on temporary feature environments. To do the former, you need to have environment aliases enabled in your Contentful space.

For production-type environments, it creates a copy of the `master` environment, applies migrations, and switches the alias to
point at the freshly migrated environment. The original environment is still available in case a rollback is needed.

For temporary environments it checks if the environment already exists, deletes it if it does, creates it
as a copy of master and applies migrations. This is intended for environments working with feature branches of applications.

A third type of environment is supported as well: a permanent, non-aliased environment where there is no need for rollbacks.
These are treated similar to temporary environments, but the environment is not deleted and recreated from master if it
already exists before migrations are applied. This is intended for staging, QA or similar environments.

## Writing migrations

Read the official Contentful [tutorial](https://www.contentful.com/developers/docs/tutorials/cli/scripting-migrations/).

## Contentful setup

To track which migrations have been applied to an environment, the tool requires a `migrationVersions` content model to be
manually created in the environment. It needs to have two fields: `version` (short text) and `executedAt` (date & time).
The name and field id of those fields need to be the same.

## Installation

### Globally

```bash
npm install -g @becklyn/contentful-migrations
```


### Locally

```bash
npm install --save-dev @becklyn/contentful-migrations
```

## Usage

### Global installation 

```bash
becklyn-contentful-migrate <args>
```

### Local installation

```bash
npx becklyn-contentful-migrate <args>
```


### Arguments

```bash
becklyn-contentful-migrate <space_id> <environment> <cma_access_token> [migrations_dir] [config_file]
```

* `space_id`: The id of the Contentful space to run migrations on. If you open Contentful, your url will be something like `https://app.contentful.com/spaces/a1ht3vblaj8x/...`; in this case, `a1ht3vblaj8x` is your space id.
* `environment`: The name of the environment on which to execute migrations on.
* `cma_access_token`: You need to create a CMA access token in your space to execute migrations, and pass it to the command.
* `migrations_dir`: Path to the folder where your migrations are stored. Defaults to `migrations`.
* `config_file`: Path to the migrations configuration file. Defaults to `contentful_migrations.json`.

## Configuration

The configuration file is a json file with the following structure:

```json
{
  "environments": [
    {
      "environment": "master",
      "alias": true,
      "persistent": false
    },
    {
      "environment": "foo",
      "alias": false,
      "persistent": false
    },
    ...
  ]
}
```

For each environment, two configuration properties are available:

* `alias`: Set to true if the environment is aliased, in other words if it should be treated as a production-type environment as described in the introduction. If set to true, `persistent` is ignored.
* `persistent`: Only relevant if `alias` is set to `false`. If false, the environment will be deleted and recreated from master before migrations are executed. If true, it migrations will be applied to it without deletion/recreation.  

The default configuration for environments named `master`, `staging` and `integration` have `alias` set to true, while for all other environments both `alias` and `persistent` are set to false. Use the configuration file to override this behavior.

## Examples
The `examples` folder contains examples of migrations, initial content they can be applied to, and a configuration file.