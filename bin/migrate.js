#!/usr/bin/env node

const path = require("path");

class Space {
    constructor(spaceId, space) {
        this.id = spaceId;
        this._space = space;
    }

    async getEnvironment(environmentId)
    {
        return this._space.getEnvironment(environmentId);
    }

    async createEnvironmentWithId(environmentId) {
        return this._space.createEnvironmentWithId(environmentId, {
            name: environmentId,
        });
    }

    async getApiKeys() {
        return this._space.getApiKeys();
    }

    async getEnvironmentAlias(environmentInput) {
        return this._space.getEnvironmentAlias(environmentInput);
    }
}

class Environment {
    constructor(environmentId, environmentConfig, environment, space) {
        this.id = environmentId;
        this.config = environmentConfig;
        this._environment = environment;
        this.space = space;
    }

    async getStatus() {
        return (await this.space.getEnvironment(this.id)).sys.status.sys.id;
    }

    async getLocales() {
        return this._environment.getLocales();
    }
}


// utility fns
const getVersionOfFile = (file) => file.replace(".js", "").replace(/_/g, ".");
const getFileOfVersion = (version) => version.replace(/\./g, "_") + ".js";

(async () => {
        const {createClient} = require("contentful-management");

        const [, , SPACE_ID, ENVIRONMENT_INPUT, CMA_ACCESS_TOKEN, MIGRATIONS_DIR_INPUT, CONFIG_FILE_INPUT] = process.argv;
        const MIGRATIONS_DIR = path.join(".", MIGRATIONS_DIR_INPUT ?? "migrations");
        const CONFIG_FILE = path.join(".", CONFIG_FILE_INPUT ?? "contentful_migrations.json");

        console.log(CMA_ACCESS_TOKEN, MIGRATIONS_DIR_INPUT, MIGRATIONS_DIR, CONFIG_FILE);

        let environmentConfig;
        try {
            environmentConfig = loadConfig(CONFIG_FILE, ENVIRONMENT_INPUT);
            console.log(environmentConfig);
        } catch (e) {
            return;
        }

        const client = createClient({
            accessToken: CMA_ACCESS_TOKEN,
        });
        const space = new Space(SPACE_ID, await client.getSpace(SPACE_ID));

        console.log("Running with the following configuration");
        console.log(`SPACE_ID: ${SPACE_ID}`);

        const environment = await prepareEnvironment(space, environmentConfig);

        await updateApiKeys(environment);

        const defaultLocale = await getDefaultLocale(environment);

        const availableMigrations = await getAvailableMigrations(MIGRATIONS_DIR);

        const migrationsToExecute = await calculateMigrationsToExecute(environment, availableMigrations, defaultLocale);

        const migrationOptions = {
            spaceId: environment.space.id,
            environmentId: environment.id,
            accessToken: CMA_ACCESS_TOKEN,
            yes: true,
        };

        await executeMigrations(environment, migrationsToExecute, defaultLocale, migrationOptions);

        await updateAlias(environment);

        console.log('All done!');
})();

function loadConfig(configFile, environment)
{
    let configs;

    try {
        const fs = require("fs");
        configs = JSON.parse(fs.readFileSync(configFile).toString());
    } catch (e) {
        console.log(`Configuration file ${configFile} not found, aborting`);
        throw e;
    }

    // By default, "protected" environments are master, staging and integration. Default values for them are alias: true and persistent: false.
    // This means the environment name is actually used by an alias, and actual environments are named as master_sometimestamp, for example.
    // During the migration, a new copy of the currently aliased environment will be created, and the alias redirected to it if the migration succeeds.

    // persistent: true means that fresh copies of the environment should not be created for the migrations and that they should be applied directly
    // to the environment in question. If an environment is set to alias: true, the value of persistent is ignored because aliased environments can't be
    // persistent.

    // Default config values for non-protected environments are alias: false, persistent: false. That means the environment will always be deleted
    // before migrations are executed and a fresh copy will be created from master. This is primarily intended for feature branches.

    const isProtectedByDefault = environment => environment === "master" || environment === "staging" || environment === "integration";

    let config = configs.environments.find(conf => conf.environment === environment);
    if (!config) {
        config = {
            "environment": environment,
            "alias": isProtectedByDefault(environment),
            "persistent": false
        }
    } else {
        // fill out all config properties if missing
        if (!config.hasOwnProperty("alias")) {
            // a missing alias property should only be set to true if the persistent property is false (or undefined) and the branch is protected
            config.alias = !config.persistent && isProtectedByDefault(environment);
        }
        if (!config.hasOwnProperty("persistent")) {
            config.persistent = false;
        }
    }

    return config;
}

function getStringDate() {
    const d = new Date();
    function pad(n) {
        return n < 10 ? '0' + n : n;
    }
    return (
        d.toISOString().substring(0, 10) +
        '-' +
        pad(d.getUTCHours()) +
        pad(d.getUTCMinutes())
    );
}

function calculateEnvironmentId(environmentConfig) {
    if (environmentConfig.alias) {
        console.log(`Running on aliased environment ${environmentConfig.environment}.`);
        const environmentId = `${environmentConfig.environment}-`.concat(getStringDate());
        console.log(`Setting environment id to ${environmentId}`);
        return environmentId;
    }

    if (environmentConfig.persistent) {
        console.log(`Running on persistent environment ${environmentConfig.environment}.`);
    } else {
        console.log(`Running on feature branch ${environmentConfig.environment}.`);
    }

    return environmentConfig.environment;
}

async function prepareEnvironment(space, environmentConfig) {
    const environmentId = calculateEnvironmentId(environmentConfig);

    let environment;

    if (environmentConfig.alias) {
        environment = await createAliasedEnvironment(space, environmentId);
    } else if (environmentConfig.persistent) {
        environment = await getOrCreatePersistentEnvironment(space, environmentId);
    } else {
        environment = await getOrCreateTransientEnvironment(space, environmentId);
    }

    environment = new Environment(environmentId, environmentConfig, environment, space);

    await waitForEnvironmentWarmup(environment);

    return environment;
}

async function createAliasedEnvironment(space, environmentId) {
    try {
        console.log(`Checking for existing version of aliased environment ${environmentId}`);
        await space.getEnvironment(environmentId);
    } catch (e) {
        console.log('Not found, creating a new one');
        return await space.createEnvironmentWithId(environmentId, {
            name: environmentId,
        });
    }

    console.log('Environment found, aborting');
    throw new Error(`Existing verion of aliased environment ${environmentId} found, aborting`);
}

async function getOrCreatePersistentEnvironment(space, environmentId) {
    try {
        console.log(`Checking for existing version of persistent environment ${environmentId}`);
        const environment = await space.getEnvironment(environmentId);

        console.log('Environment found, using it');
        return environment;
    } catch (e) {
        console.log('Environment not found, creating a new one');
        return await space.createEnvironmentWithId(environmentId, {
            name: environmentId,
        });
    }
}

async function getOrCreateTransientEnvironment(space, environmentId) {
    try {
        console.log(`Checking for existing version of transient environment ${environmentId}`);
        let environment = await space.getEnvironment(environmentId);

        console.log(`Existing environment found, deleting`);
        await environment.delete();
    } catch (e) {
        console.log('Environment not found');
    }

    console.log(`Creating a fresh copy`);
    return await space.createEnvironmentWithId(environmentId, {
        name: environmentId,
    });
}

async function waitForEnvironmentWarmup(environment) {
    const DELAY = 3000;
    const MAX_NUMBER_OF_TRIES = 10;
    let count = 0;

    console.log('Waiting for environment processing...');

    while (count < MAX_NUMBER_OF_TRIES) {
        const status = await environment.getStatus();

        if (status === 'ready' || status === 'failed') {
            if (status === 'ready') {
                console.log(`Successfully processed new environment ${environment.id}`);

                return environment;
            } else {
                console.log('Environment creation failed');
            }
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, DELAY));
        count++;
    }

    throw new Error('Environment preparation timed out');
}

async function updateApiKeys(environment) {
    console.log('Update API keys to allow access to new environment');
    const newEnv = {
        sys: {
            type: 'Link',
            linkType: 'Environment',
            id: environment.id,
        },
    };

    const { items: keys } = await environment.space.getApiKeys();
    await Promise.all(
        keys.map((key) => {
            console.log(`Updating - ${key.sys.id}`);
            key.environments.push(newEnv);
            return key.update();
        })
    );
}

async function getAvailableMigrations(migrations_dir) {
    const {promisify} = require("util");
    const {readdir} = require("fs");
    const readdirAsync = promisify(readdir);

    console.log('Read all the available migrations from the file system');
    const availableMigrations = (await readdirAsync(migrations_dir))
        .filter((file) => /^\d+?\.js$/.test(file))
        .map((file) => getVersionOfFile(file));

    console.log('Available migrations:');
    console.log(availableMigrations);

    return availableMigrations;
}

async function getDefaultLocale(environment) {
    return (await environment.getLocales()).items.find(
        (locale) => locale.default
    ).code;
}

async function calculateMigrationsToExecute(environment, availableMigrations, defaultLocale) {
    console.log('Figure out migrations already executed in the contentful space');
    const { items: versions } = await environment._environment.getEntries({
        content_type: 'migrationVersions',
    });

    // ---------------------------------------------------------------------------
    console.log('Evaluate which migrations to execute');
    const migrationsToExecute = availableMigrations.filter(
        availableMigration => !versions.find(version => version.fields.version[defaultLocale] === availableMigration)
    );

    console.log('Migrations to execute:');
    console.log(migrationsToExecute);

    return migrationsToExecute;
}

async function executeMigrations(environment, migrationsToExecute, defaultLocale, migrationOptions) {
    console.log('Execute migrations');

    const {default: runMigration} = require("contentful-migration/built/bin/cli");

    let migrationToExecute;
    while ((migrationToExecute = migrationsToExecute.shift())) {
        const filePath = path.join(
            __dirname,
            '..',
            'migrations',
            getFileOfVersion(migrationToExecute)
        );
        console.log(`Running ${filePath}`);
        await runMigration(
            Object.assign(migrationOptions, {
                filePath,
            })
        );
        console.log(`${migrationToExecute} succeeded`);

        const newVersionEntry = await environment._environment.createEntry('migrationVersions', {
            fields: {
                version: {
                    [defaultLocale]: migrationToExecute
                },
                executedAt: {
                    [defaultLocale]: new Date()
                }
            }
        });
        await newVersionEntry.publish();

        console.log(`Saved ${migrationToExecute} to migrationVersions`);
    }
}

async function updateAlias(environment) {
    console.log('Checking if we need to update an alias');
    if (environment.config.alias) {
        console.log(`Running on aliased environment ${environment.config.environment}.`);
        console.log(`Updating alias to ${environment.id}.`);
        await environment.space
            .getEnvironmentAlias(environment.config.environment)
            .then((alias) => {
                alias.environment.sys.id = environment.id;
                return alias.update();
            })
            .then((alias) => console.log(`alias ${alias.sys.id} updated.`))
            .catch(console.error);
        console.log(`${environment.config.environment} alias updated.`);
    } else {
        console.log('Running on feature or persistent branch');
        console.log('No alias changes required');
    }
}
