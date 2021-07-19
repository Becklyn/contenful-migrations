#!/usr/bin/env node

const path = require("path");

// utility fns
const getVersionOfFile = (file) => file.replace(".js", "").replace(/_/g, ".");
const getFileOfVersion = (version) => version.replace(/\./g, "_") + ".js";

(async () => {
        const {createClient} = require("contentful-management");

        const [, , SPACE_ID, ENVIRONMENT_INPUT, CMA_ACCESS_TOKEN, MIGRATIONS_DIR_INPUT] = process.argv;
        const MIGRATIONS_DIR = path.join(".", MIGRATIONS_DIR_INPUT ?? "migrations");

        console.log(CMA_ACCESS_TOKEN, MIGRATIONS_DIR_INPUT, MIGRATIONS_DIR);

        const client = createClient({
            accessToken: CMA_ACCESS_TOKEN,
        });
        const space = await client.getSpace(SPACE_ID);

        console.log("Running with the following configuration");
        console.log(`SPACE_ID: ${SPACE_ID}`);

        const ENVIRONMENT_ID = calculateEnvironmentId(ENVIRONMENT_INPUT);

        console.log(`ENVIRONMENT_ID: ${ENVIRONMENT_ID}`);

        const environment = await prepareEnvironment(space, ENVIRONMENT_ID);

        await updateApiKeys(space, ENVIRONMENT_ID);

        const defaultLocale = await getDefaultLocale(environment);

        const availableMigrations = await getAvailableMigrations(MIGRATIONS_DIR);

        const migrationsToExecute = await calculateMigrationsToExecute(environment, availableMigrations);

        const migrationOptions = {
            spaceId: SPACE_ID,
            environmentId: ENVIRONMENT_ID,
            accessToken: CMA_ACCESS_TOKEN,
            yes: true,
        };

        await executeMigrations(environment, migrationsToExecute, defaultLocale, migrationOptions);

        await updateAlias(space, ENVIRONMENT_INPUT, ENVIRONMENT_ID);

        console.log('All done!');
})();


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

function calculateEnvironmentId(environmentInput) {
    if (
        environmentInput === 'master' ||
        environmentInput === 'staging' ||
        environmentInput === 'integration'
    ) {
        console.log(`Running on ${environmentInput}.`);
        console.log(`Updating ${environmentInput} alias.`);
        return `${environmentInput}-`.concat(getStringDate());
    }

    console.log('Running on feature branch');
    return environmentInput;
}

async function prepareEnvironment(space, environment_id) {
    let environment;

    // ---------------------------------------------------------------------------
    console.log(`Checking for existing versions of environment: ${environment_id}`);

    try {
        environment = await space.getEnvironment(environment_id);
        if (
            environment_id !== 'master' &&
            environment_id !== 'staging' &&
            environment_id !== 'integration'
        ) {
            await environment.delete();
            console.log('Environment deleted');
        }
    } catch (e) {
        console.log('Environment not found');
    }

    // ---------------------------------------------------------------------------
    if (
        environment_id !== 'master' &&
        environment_id !== 'staging' &&
        environment_id !== 'integration'
    ) {
        console.log(`Creating environment ${environment_id}`);
        environment = await space.createEnvironmentWithId(environment_id, {
            name: environment_id,
        });
    }

    // ---------------------------------------------------------------------------
    const DELAY = 3000;
    const MAX_NUMBER_OF_TRIES = 10;
    let count = 0;

    console.log('Waiting for environment processing...');

    while (count < MAX_NUMBER_OF_TRIES) {
        const status = (await space.getEnvironment(environment.sys.id)).sys.status.sys
            .id;

        if (status === 'ready' || status === 'failed') {
            if (status === 'ready') {
                console.log(`Successfully processed new environment (${environment_id})`);

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

async function updateApiKeys(space, environment_id) {
    console.log('Update API keys to allow access to new environment');
    const newEnv = {
        sys: {
            type: 'Link',
            linkType: 'Environment',
            id: environment_id,
        },
    };

    const { items: keys } = await space.getApiKeys();
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

async function calculateMigrationsToExecute(environment, availableMigrations) {
    console.log('Figure out migrations already executed in the contentful space');
    const { items: versions } = await environment.getEntries({
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

        const newVersionEntry = await environment.createEntry('migrationVersions', {
            fields: {
                version: {
                    [defaultLocale]: migrationToExecute
                },
                executedAt: {
                    [defaultLocale]: new Date()
                }
            }
        });//.then(entry => entry.publish());
        await newVersionEntry.publish();

        console.log(`Saved ${migrationToExecute} to migrationVersions`);
    }
}

async function updateAlias(space, environment_input, environment_id) {
    console.log('Checking if we need to update an alias');
    if (
        environment_input === 'master' ||
        environment_input === 'staging' ||
        environment_input === 'integration'
    ) {
        console.log(`Running on ${environment_input}.`);
        console.log(`Updating ${environment_input} alias.`);
        await space
            .getEnvironmentAlias(environment_input)
            .then((alias) => {
                alias.environment.sys.id = environment_id;
                return alias.update();
            })
            .then((alias) => console.log(`alias ${alias.sys.id} updated.`))
            .catch(console.error);
        console.log(`${environment_input} alias updated.`);
    } else {
        console.log('Running on feature branch');
        console.log('No alias changes required');
    }
}
