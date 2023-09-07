import { toNano } from 'ton-core';
import { LightClient } from '../wrappers/LightClient';
import { compile, NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    const lightClient = provider.open(
        LightClient.createFromConfig(
            {
                id: Math.floor(Math.random() * 10000),
                counter: 0,
            },
            await compile('LightClient')
        )
    );

    await lightClient.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(lightClient.address);

    console.log('ID', await lightClient.getID());
}
