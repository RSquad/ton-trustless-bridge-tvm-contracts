import {Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode} from 'ton-core';

export type LightClientConfig = {
    id: number;
};

export function lightClientConfigToCell(config: LightClientConfig): Cell {
    return beginCell().storeUint(config.id, 32).storeRef(beginCell().storeDict().endCell()).endCell();
}

export const Opcodes = {
    increase: 0x7e8764ef,
    init_committee: 0xed62943d,
    update_committee: 0xd162d319,
};

export class LightClient implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new LightClient(address);
    }

    static createFromConfig(config: LightClientConfig, code: Cell, workchain = 0) {
        const data = lightClientConfigToCell(config);
        const init = { code, data };
        return new LightClient(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendIncrease(
        provider: ContractProvider,
        via: Sender,
        opts: {
            increaseBy: number;
            value: bigint;
            queryID?: number;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.increase, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.increaseBy, 32)
                .endCell(),
        });
    }

    async sendInitCommittee(
        provider: ContractProvider,
        via: Sender,
        opts: {

            value: bigint;
            queryID?: number;
            committee: Cell
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.init_committee, 32)
                .storeUint(opts.queryID ?? 0, 64)

                .storeRef(opts.committee)
                .endCell(),
        });
    }

    async sendUpdateCommittee(
        provider: ContractProvider,
        via: Sender,
        opts: {

            value: bigint;
            queryID?: number;
            committee: Cell;
            aggregate: Cell;
            msg: Cell;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.update_committee, 32)
                .storeUint(opts.queryID ?? 0, 64)

                .storeRef(opts.committee)
                .storeRef(opts.aggregate)
                .storeRef(opts.msg)
                .endCell(),
        });
    }

    // async getCounter(provider: ContractProvider) {
    //     const result = await provider.get('get_counter', []);
    //     return result.stack.readNumber();
    // }

    // async getID(provider: ContractProvider) {
    //     const result = await provider.get('get_id', []);
    //     return result.stack.readNumber();
    // }
}
