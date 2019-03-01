const fetch = require('node-fetch');
const semver = require('semver');
const fs = require('fs-extra');
const path = require('path');
const cp = require('child_process');
const util = require('util');

const readPackageJsonFromArchive = require('./utilities').readPackageJsonFromArchive;

async function fetchPackage({ name, reference }) {

    // Check for file paths
    if ([`/`, `./`, `../`].some(prefix => reference.startsWith(prefix))) {
        return await fs.readFile(reference);
    }

    // Check for version number
    if (semver.valid(reference)) {
        return await fetchPackage({
            name,
            reference: `https://registry.yarnpkg.com/${name}/-/${name}-${reference}.tgz`,
        });
    }

    let response = await fetch(reference);

    if (!response.ok) {
        throw new Error(`Couldn't fetch package ${reference}`);
    }

    return await response.buffer();
}

async function getPinnedReference({ name, reference }) {
    // semver check for packages
    if (semver.validRange(reference) && !semver.valid(reference)) {
        let response = await fetch(`https://registry.yarnpkg.com/${name}`);
        let info = await response.json();

        let versions = Object.keys(info.versions);
        let maxSatisfying = semver.maxSatisfying(versions, reference);

        if (maxSatisfying === null) {
            throw new Error(`Couldn't find a version matching ${reference} for package ${name}`);
        }

        reference = maxSatisfying;
    }

    return { name, reference };
}

async function getPackageDependencies({ name, reference }) {
    let packageBuffer = await fetchPackage({ name, reference });
    let packageJson = JSON.parse(await readPackageJsonFromArchive(packageBuffer));

    // some packages have no dependencies field
    let dependencies = packageJson.dependencies || {};

    return Object.keys(dependencies).map(name => {
        return { name, reference: dependencies[name] };
    });
}

async function getPackageDependencyTree({ name, reference, dependencies }, available = new Map()) {
    return {
        name,
        reference,
        dependencies: await Promise.all(
            dependencies.filter(volatileDependency => {
                let availableReference = available.get(volatileDependency.name);

                if (volatileDependency.reference === availableReference)
                    return false;

                if (
                    semver.validRange(volatileDependency.reference) &&
                    semver.satisfies(availableReference, volatileDependency.reference)
                )
                    return false;

                return true;
            })
                .map(async volatileDependency => {
                    let pinnedDependency = await getPinnedReference(volatileDependency);
                    let subDependencies = await getPackageDependencies(pinnedDependency);

                    let subAvailable = new Map(available);
                    subAvailable.set(pinnedDependency.name, pinnedDependency.reference);

                    return await getPackageDependencyTree(
                        Object.assign({}, pinnedDependency, { dependencies: subDependencies }),
                        subAvailable
                    );
                })
        ),
    };
}

// This function extracts an archive somewhere on the disk
const extractNpmArchiveTo = require('./utilities').extractNpmArchiveTo;

async function linkPackages({ name, reference, dependencies }, cwd) {
    let dependencyTree = await getPackageDependencyTree({
        name,
        reference,
        dependencies
    });

    if (reference) {
        let packageBuffer = await fetchPackage({ name, reference });
        await extractNpmArchiveTo(packageBuffer, cwd);
    }

    await Promise.all(
        dependencies.map(async ({ name, reference, dependencies }) => {
            let target = `${cwd}/node_modules/${name}`;
            let binTarget = `${cwd}/node_modules/.bin`;

            await linkPackages({ name, reference, dependencies }, target);

            let dependencyPackageJson = require(`${target}/package.json`);
            let bin = dependencyPackageJson.bin || {};

            if (typeof bin === 'string') bin = { [name]: bin };

            for (let binName of Object.keys(bin)) {
                let source = resolve(target, bin[binName]);
                let dest = `${binTarget}/${binName}`;

                await fs.mkdirp(`${cwd}/node_modules/.bin`);
                await fs.symlink(relative(binTarget, source), dest);
            }

            if (dependencyPackageJson.scripts) {
                for (let scriptName of [`preinstall`, `install`, `postinstall`]) {
                    let script = dependencyPackageJson.scripts[scriptName];

                    if (!script)
                        continue;

                    await exec(script, {
                        cwd: target,
                        env: Object.assign({}, process.env, {
                            PATH: `${target}/node_modules/.bin:${process.env.PATH}`,
                        }),
                    });
                }
            }
        })
    );
}

function optimizePackageTree({ name, reference, dependencies }) {
    dependencies = dependencies.map(dependency => {
        return optimizePackageTree(dependency);
    });

    for (let hardDependency of dependencies.slice()) {
        for (let subDependency of hardDependency.dependencies.slice()) {
            let availableDependency = dependencies.find(dependency => {
                return dependency.name === subDependency.name;
            });

            if (!availableDependency.length) dependencies.push(subDependency);

            if (
                !availableDependency ||
                availableDependency.reference === subDependency.reference
            ) {
                hardDependency.dependencies.splice(
                    hardDependency.dependencies.findIndex(dependency => {
                        return dependency.name === subDependency.name;
                    })
                );
            }
        }
    }

    return { name, reference, dependencies };
}