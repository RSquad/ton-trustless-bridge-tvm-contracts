import {compile} from '@ton-community/blueprint';
import {Blockchain, SandboxContract, TreasuryContract} from '@ton-community/sandbox';
import '@ton-community/test-utils';
import {ethers} from 'ethers';
import {Cell, Dictionary, address, beginCell, toNano} from 'ton-core';
import {sha256} from 'ton-crypto';
import {IReceiptJSON, Receipt} from '../evm-data/receipt';
import {Adapter} from '../wrappers/Adapter';
import {JettonMinter} from '../wrappers/JettonMinter';
import {JettonWallet} from '../wrappers/JettonWallet';
import {jsonReceipt} from './mock/receiptWithEvents';
import {expectFail, expectSuccess} from './utils/tests';

const originalTopicId = '0x09a9af46918f2e52460329a694cdd4cd6d55354ea9b336b88b4dea59914a9a83';
const receipt = JSON.stringify(jsonReceipt);

export enum BridgeErrors {
    MSG_VALUE_TOO_SMALL = 200,
}

describe('Adapter', () => {
    let code: Cell;
    let minterCode: Cell;
    let walletCode: Cell;

    beforeAll(async () => {
        code = await compile('Adapter');
        minterCode = await compile('JettonMinter');
        walletCode = await compile('JettonWallet');
    });

    let blockchain: Blockchain;
    let adapter: SandboxContract<Adapter>;
    let admin: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let jettonMinter: SandboxContract<JettonMinter>;

    const ethAddr = ethers.Wallet.createRandom().address;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        admin = await blockchain.treasury('admin');
        user = await blockchain.treasury('user');

        adapter = blockchain.openContract(Adapter.createFromConfig({
            // jminter_addr: jettonMinter.address,
            topic_mint_id: originalTopicId,
            light_client_addr: admin.address,
        }, code));

        const jETHContent = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        jETHContent
            .set(
                BigInt('0x' + (await sha256('name')).toString('hex')),
                beginCell().storeUint(0x00, 8).storeBuffer(Buffer.from('wETH', 'utf8')).endCell()
            )
            .set(
                BigInt('0x' + (await sha256('decimals')).toString('hex')),
                beginCell().storeUint(0x00, 8).storeBuffer(Buffer.from('18', 'utf8')).endCell()
            );

        jettonMinter = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    adminAddress: adapter.address,
                    content: beginCell().storeInt(0x00, 8).storeDict(jETHContent).endCell(),
                    jettonWalletCode: walletCode,
                },
                minterCode
            )
        );

        const deployer = await blockchain.treasury('deployer');

        const minterDeployRes = await jettonMinter.sendDeploy(deployer.getSender(), toNano('0.05'));

        const adapterDeployRes = await adapter.sendDeploy(admin.getSender(), toNano('0.05'));

        await adapter.sendJminterAddr(admin.getSender(), {
            value: toNano('0.05'),
            jminterAddr: jettonMinter.address,
        })

        expect(adapterDeployRes.transactions).toHaveTransaction({
            from: admin.address,
            to: adapter.address,
            deploy: true,
            success: true,
        });

        expect(minterDeployRes.transactions).toHaveTransaction({
            from: deployer.address,
            to: jettonMinter.address,
            deploy: true,
            success: true,
        });
    });

    it('should generate msg', async () => {
        const dataArr = jsonReceipt.logs.filter((l) => l.topics.includes(originalTopicId)).map((l) => l.data);
        const r = Receipt.fromJSON(JSON.parse(receipt) as unknown as IReceiptJSON);
        const cell = r.toCell();
        const rAddr = '0:0112aeb9f1d2e0d4ac4f8576718f4bdaa5930d61ebe8b6a788347efcea5a70c1';
        let testAddress = address(rAddr);

        const userWalletAddr = await jettonMinter.getWalletAddress(testAddress);
        const jettonWallet = blockchain.openContract(JettonWallet.createFromAddress(userWalletAddr));

        const sendReceiptResult = await adapter.sendConfirmReceipt(admin.getSender(), {
            value: toNano('1.05'),
            receipt: cell,
        });

        const sendReceiptResult2 = await adapter.sendConfirmReceipt(admin.getSender(), {
            value: toNano('1.05'),
            receipt: cell,
        });

        const userBalance = await jettonWallet.getBalance();
        expectSuccess(sendReceiptResult.transactions, admin.address, adapter.address);
        expectSuccess(sendReceiptResult.transactions, adapter.address, jettonMinter.address);
        expectSuccess(sendReceiptResult.transactions, jettonMinter.address, jettonWallet.address);

        expectSuccess(sendReceiptResult2.transactions, admin.address, adapter.address);
        expectSuccess(sendReceiptResult2.transactions, adapter.address, jettonMinter.address);
        expectSuccess(sendReceiptResult2.transactions, jettonMinter.address, jettonWallet.address);

        expect(userBalance.amount).toBe(2n * BigInt('0x3e8'));
    });

    it('should throw MSG_VALUE_TOO_SMALL if msg.value less that amount + 0.2 TON', async () => {
        const amount = toNano('1');
        const wrapResult = await adapter.sendWrap(admin.getSender(), toNano('0.1'), {
            amount,
            ethAddr,
        });

        expectFail(
            wrapResult.transactions,
            admin.getSender().address,
            adapter.address,
            BridgeErrors.MSG_VALUE_TOO_SMALL
        );
    });

    it('should emit log after receive wrap op', async () => {
        const amount = toNano('1');
        const wrapResult = await adapter.sendWrap(admin.getSender(), toNano('0.2') + amount, {
            amount,
            ethAddr,
        });

        expectSuccess(wrapResult.transactions, admin.getSender().address, adapter.address);
        // TODO: how to check in another way
        expect(
            wrapResult.transactions
                .filter((t) => t.externals.length > 0)
                .map((t) => t.outMessages.values().map((m) => m.info.dest?.toString()))
        ).toStrictEqual([['External<256:1>']]); // log::wrap = 1
    });
});
