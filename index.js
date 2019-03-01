const fetch = require('node-fetch');
const semver = require('semver');
const fs = require('fs-extra');

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