import fetch from 'node-fetch';
import semver from 'semver';
import fs from 'fs-extra';

async function fetchPackage({name, reference}) {

    // Check for file paths
    if([`/`, `./`, `../`].some(prefix => reference.startsWith(prefix))) {
        return await fs.readFile(reference);
    }

    // Check for version number
    if(semver.valid(reference)) {
        return await fetchPackage({
            name,
            reference: `https://registry.yarnpkg.com/${name}/-/${name}-${reference}.tgz`,
        });
    }

    let response = await fetch(reference);

    if(!response.ok) {
        throw new Error(`Couldn't fetch package ${reference}`);
    }

    return await response.buffer();
}