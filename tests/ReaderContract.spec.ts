import {hash64} from '@chainsafe/ssz';
import {compile} from '@ton-community/blueprint';
import {Blockchain, SandboxContract} from '@ton-community/sandbox';
import '@ton-community/test-utils';
import {rlp} from 'ethereumjs-util';
import {Builder, Cell, beginCell, toNano} from 'ton-core';
import {BlockHeader} from '../evm-data/block-header';
import {IReceiptJSON, Receipt} from '../evm-data/receipt';
import {bytes, toNumber} from '../evm-data/utils';
import {verifyMerkleProof} from '../evm-data/verify-merkle-proof';
import {ReaderContract} from '../wrappers/ReaderContract';
import {jsonReceipt} from './mocks';
import {ExecutionPayloadHeader, SyncCommittee} from './ssz/finally_update';
import updateJson from './ssz/finally_update.json';

describe('ReaderContract', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('ReaderContract');
    });

    let blockchain: Blockchain;
    let readerContract: SandboxContract<ReaderContract>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        readerContract = blockchain.openContract(
            ReaderContract.createFromConfig(
                {
                    id: 0,
                    counter: 0,
                },
                code
            )
        );

        const deployer = await blockchain.treasury('deployer');

        const deployResult = await readerContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: readerContract.address,
            deploy: true,
            success: true,
        });
    });

    it('should emit correct hash', async () => {
        const r = Receipt.fromJSON(jsonReceipt as unknown as IReceiptJSON);
        const cell = r.toCell();

        const expectedHash = BigInt('0x' + r.hash().toString('hex'));

        const increaser = await blockchain.treasury('increaser');
        const calcHashRes = await readerContract.sendCalcHash(increaser.getSender(), {
            value: toNano('0.5'),
            receipt: cell,
        });

        expect(calcHashRes.transactions).toHaveTransaction({
            from: increaser.address,
            to: readerContract.address,
            success: true,
        });

        expect(calcHashRes.externals.length).toEqual(1);

        const externalOutBodySlice = calcHashRes.externals[0].body.asSlice();
        const actualHash = externalOutBodySlice.loadUintBig(256);
        expect(expectedHash).toBe(actualHash);
        console.log(r.hash().toString('hex'));
    });

    it('should check merkle proof', async () => {
        const { receipt, receiptProof, blockHeader } = json;
        const r = Receipt.fromJSON(receipt as unknown as IReceiptJSON);
        const block = BlockHeader.fromHex(blockHeader);
        const cell = r.toCell();

        const increaser = await blockchain.treasury('increaser');

        const cells = receiptProof
            .map(bytes)
            .map((pr) => rlp.decode(pr) as any as Buffer[])
            .map((prb) => {
                // const data:node_leaf = "data:node_leaf"c; ;; b95a0273
                // const data:node_branch = "data:node_branch"c; ;; 40a54ae8
                // const data:empty_branch = "data:empty_branch"c; ;; e28eb9cc
                // TODO: split big data
                let cells: Builder[] = [];
                if (prb.length === 17) {
                    cells = [beginCell().storeUint(0x40a54ae8, 32)];
                    cells = [...cells, ...prb.map((proofPart) => beginCell().storeBuffer(proofPart, proofPart.length))];
                }
                if (prb.length === 2) {
                    let proof_receipt_part = prb[1];
                    const proof_receipt_part_builders: Builder[] = [];
                    while (proof_receipt_part.length) {
                        const part = proof_receipt_part.subarray(0, 32);
                        proof_receipt_part_builders.push(beginCell().storeBuffer(part, Math.min(part.length, 32)));
                        proof_receipt_part = proof_receipt_part.subarray(32);
                    }
                    cells = [beginCell().storeUint(0xb95a0273, 32)];
                    cells = [...cells, beginCell().storeBuffer(prb[0], prb[0].length), ...proof_receipt_part_builders];
                }
                if (prb.length === 0) {
                    cells = [beginCell().storeUint(0xe28eb9cc, 32)];
                }
                // cells = prb.map((proofPart) =>
                //     beginCell().storeBuffer(proofPart.subarray(0, 32), Math.min(proofPart.length, 32))
                // );

                for (let i = cells.length - 1; i > 0; i--) {
                    if (i < cells.length - 1) {
                        cells[i] = cells[i].storeRef(cells[i + 1]);
                    }
                    cells[i].endCell();
                }
                return cells[0].storeRef(cells[1]);
            });

        for (let i = cells.length - 1; i > 0; i--) {
            if (i < cells.length - 1) {
                cells[i] = cells[i].storeRef(cells[i + 1]);
            }
            cells[i].endCell();
        }
        const proofBoc = cells[0].storeRef(cells[1]).endCell();
        console.log(proofBoc.refs.length);

        const callback = await readerContract.sendVerifyProof(increaser.getSender(), {
            value: toNano('5.5'),
            receipt: cell,
            rootHash: beginCell().storeBuffer(block.receiptTrie).endCell(),
            path: beginCell()
                .storeBuffer(rlp.encode(toNumber(receipt.transactionIndex)))
                .endCell(),
            receiptProof: proofBoc,
        });

        // const externalOutBodySlice = callback.externals[0]?.body;
        console.log(callback.externals.map((e) => e?.body));
        console.log(block.receiptTrie.toString('hex'));
        // console.log(callback.transactions.map(t => t.description))
        // verifiy the proof (throw Error on false proof)
        const res = await verifyMerkleProof(
            block.receiptTrie, // expected merkle root
            rlp.encode(toNumber(receipt.transactionIndex)), // path, which is the transsactionIndex
            receiptProof.map(bytes), // array of Buffer with the merkle-proof-data
            r.serialize(),
            'The TransactionReceipt can not be verified'
        );

        expect(callback.transactions).toHaveTransaction({
            from: increaser.address,
            to: readerContract.address,
            success: true,
        });
    });

    it('check receipt root merkle proof', async () => {
        const data = updateJson[0].data;
        const expectedRoot = bytes(data.finalized_header.beacon.body_root);
        const path = data.finalized_header.beacon.proposer_index;
        const proof = data.finalized_header.execution_branch;
        const expectedValue = null as any;

        const res = is_valid_merkle_branch(
            Buffer.from(ExecutionPayloadHeader.hashTreeRoot({
                parentHash: bytes(data.finalized_header.execution.parent_hash),
                feeRecipient: bytes(data.finalized_header.execution.fee_recipient),
                stateRoot: bytes(data.finalized_header.execution.state_root),
                receiptsRoot: bytes(data.finalized_header.execution.receipts_root),
                logsBloom: bytes(data.finalized_header.execution.logs_bloom),
                prevRandao: bytes(data.finalized_header.execution.prev_randao),
                blockNumber: +data.finalized_header.execution.block_number,
                gasLimit: +data.finalized_header.execution.gas_limit,
                gasUsed: +data.finalized_header.execution.gas_used,
                timestamp: +data.finalized_header.execution.timestamp,
                extraData: bytes(data.finalized_header.execution.extra_data),
                baseFeePerGas: BigInt(data.finalized_header.execution.base_fee_per_gas),
                blockHash: bytes(data.finalized_header.execution.block_hash),
                transactionsRoot: bytes(data.finalized_header.execution.transactions_root),
                withdrawalsRoot: bytes(data.finalized_header.execution.withdrawals_root),
            })),
            data.finalized_header.execution_branch.map(bytes),
            data.finalized_header.execution_branch.length,
            9,
            expectedRoot
        );


        // 55 for commitee
        const res2 = is_valid_merkle_branch(
            Buffer.from(SyncCommittee.hashTreeRoot({
                pubkeys: data.next_sync_committee.pubkeys.map(bytes),
                aggregatePubkey: bytes(data.next_sync_committee.aggregate_pubkey)
            })),
            data.next_sync_committee_branch.map(bytes),
            5,
            23,
            bytes(data.attested_header.beacon.state_root),
        )

        // const res = await verifyMerkleProof(
        //     expectedRoot, // expected merkle root
        //     rlp.encode(toNumber(path)), // path, which is the transsactionIndex
        //     proof.map(bytes), // array of Buffer with the merkle-proof-data
        //     expectedValue,
        //     'The TransactionReceipt can not be verified'
        // );

        console.log('ok', res, res2);

    });
});

function is_valid_merkle_branch(leaf: Buffer, branch: Buffer[], depth: number, index: number, root: Buffer) {
    let value = leaf;
    console.log('begin proof');
    console.log(value.toString('hex'), root.toString('hex'))
    for (let i = 0; i < depth; i++) {
        console.log(value.toString('hex'), branch[i]?.toString('hex'), i)
        if (Math.floor(index / (2 ** i) % 2)) {
            value = Buffer.from(hash64(branch[i], value));
        } else {
            value = Buffer.from(hash64(value, branch[i]));
        }
        console.log(value.toString('hex'))
    }
    return value.equals(root);
}



const json = {
    receipt: {
        transactionHash: '0x3df5876a57f0dde7527411b7ae6c3d4209c4952b28133d8405e8be2cee5e8175',
        transactionIndex: '0x44',
        blockHash: '0xd000be63d2a4c80468f83c03981f7eeabff2336327b2e9058770cdf904a99ff2',
        blockNumber: '0x3887a6',
        cumulativeGasUsed: '0x10147a5',
        gasUsed: '0x80b4',
        effectiveGasPrice: '0xa3',
        from: '0xc7296d50ddb12de4d2cd8c889a73b98538624f61',
        to: '0xd0df3e320aade6f44fc7adcb2308f90331dbd30b',
        contractAddress: null,
        logs: [
            {
                removed: false,
                logIndex: '0xbfc',
                transactionIndex: '0x44',
                transactionHash: '0x3df5876a57f0dde7527411b7ae6c3d4209c4952b28133d8405e8be2cee5e8175',
                blockHash: '0xd000be63d2a4c80468f83c03981f7eeabff2336327b2e9058770cdf904a99ff2',
                blockNumber: '0x3887a6',
                address: '0x8a59de294816a1d218fd97a4aa6dfd6a2fa65b93',
                data: '0x00000000000000000000000000000000000000000000000000000000000003e8',
                topics: [
                    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                    '0x000000000000000000000000c7296d50ddb12de4d2cd8c889a73b98538624f61',
                    '0x0000000000000000000000000000000000000000000000000000000000000000',
                ],
            },
            {
                removed: false,
                logIndex: '0xbfd',
                transactionIndex: '0x44',
                transactionHash: '0x3df5876a57f0dde7527411b7ae6c3d4209c4952b28133d8405e8be2cee5e8175',
                blockHash: '0xd000be63d2a4c80468f83c03981f7eeabff2336327b2e9058770cdf904a99ff2',
                blockNumber: '0x3887a6',
                address: '0xd0df3e320aade6f44fc7adcb2308f90331dbd30b',
                data: '0x0112aeb9f1d2e0d4ac4f8576718f4bdaa5930d61ebe8b6a788347efcea5a70c100000000000000000000000000000000000000000000000000000000000003e8',
                topics: ['0x09a9af46918f2e52460329a694cdd4cd6d55354ea9b336b88b4dea59914a9a83'],
            },
        ],
        logsBloom:
            '0x00000000000000000800000000000000000000000000800000000000000008000000000000000000000000000008000000000000000000000000000000000000000000000000000000000008000000000002000000000000000000000000000000000000020000000000000000000800000000000000000000000010000000000000000000000000000000000000000000000000000000000000000800000000008000200000100008000000000000000000000000000000000000000200000000800002000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000',
        status: '0x1',
        type: '0x2',
    },
    txProof: [
        '0xf8d1a04e6c5cc1d07d310d9680ccafbdce6ba2a6a9befb438944e7e16d59e0e0a72aa4a08601ceaa2651e50c4617b3ed9a979a22e21f0f3fcea50cd063ac8d5a3850c115a0357c44d86d83c51275e555130ca4ebf2fbe14cf29a9d15f4331ece04aa911f57a0590049768a9771145a4b6fb9e36fc08a8c45be11eea0d7622c47e489b50b1cb1a045b3ab97e2157b9f5d9afb1584de7069ef539c4e2ae736d5abe0789584b19aa3808080a0df5539716b59d1793e728ce1ad7b5c9e640c38da812d8e1df9348afcdbc897e08080808080808080',
        '0xf8d1a0abf42c389f286b178929e9c3a9610c6be4f8f5fee8ceafeb52635b9dcef025b0a0948a1ee02e6e4c0e58d3ed494ca368feb2ff45ad07c45dcdd6b09a2f1c4203c1a0d101acc689aa3ca780f5c79a3026bcc030646f9dd73d25f681a2ee2b88ac9388a0795e5b55cf24abe3b11e0a6fb25eaf06418ebd35da21910f5c3a9b7869663514a04df453f3a8c4f560d48f6f036fab2287e810818f051f7838ccf64980b550ae96a0b4135e0e328f0900f9923d704ced05b1f2788311b64966ffa98395c16a3752368080808080808080808080',
        '0xf8d320b8d002f8cd83aa36a782019a6e81a382a0e094d0df3e320aade6f44fc7adcb2308f90331dbd30b80b86472618aac000000000000000000000000c7296d50ddb12de4d2cd8c889a73b98538624f6100000000000000000000000000000000000000000000000000000000000003e80112aeb9f1d2e0d4ac4f8576718f4bdaa5930d61ebe8b6a788347efcea5a70c1c001a0eac68ebec5bb7b0889df7357e1548fdab5dceb4972210c951fa4dc1d527d2d61a02fa2378652bb2da91ee3111352368d6d725b65f28f8715fb897d0cfb148b82cb',
    ],
    receiptProof: [
        '0xf8d1a07b16c1c291fe06c315b1d32709790635534fa0dea082a5d680a13baa77f40982a08336335480b7944a84e8c5844cf84ebbd81061aa61edfaa66db5354ddbe0dc17a0514c903e6e9639e2311e7ed7e1f9010a1bc49448511e9f76c25cec5551e72722a012ea38f5484909af90d40a4e25a9bae64682e6e0368a54a628893c99268cc99aa0eed7a377baac3ddf92599e4959c4c329f0f2030da76e8ff2da9cebfffb1b196d808080a089a6549d48578c99dec2d535ab10314bb6ac508e07e4730702c62eb4096685858080808080808080',
        '0xf8d1a0dfa6a726e2c7313c0423b7f1cbd386c76f9c6696d37815e06409abea50333100a04c8f9d273e3df506693d39a0c166677051a42bfe99313e172ffdba4a644d8ec0a0bbdfa247b521eb01783b295a99ffb281918179c0f05a548df2f80f976682d6e6a043b10e7ef999b7cc5c83b81cd648e781f86fb9b5180d6e9b35af04d30361b9a2a06ca404a17566a3aa682843948ed3d3c7227cef5c4baa8306593139d16d743281a0a95136db17b234323c96cf46460e00f935c858a08581531850e6bd63b5bc9fdd8080808080808080808080',
        '0xf9022c20b9022802f902240184010147a5b9010000000000000000000800000000000000000000000000800000000000000008000000000000000000000000000008000000000000000000000000000000000000000000000000000000000008000000000002000000000000000000000000000000000000020000000000000000000800000000000000000000000010000000000000000000000000000000000000000000000000000000000000000800000000008000200000100008000000000000000000000000000000000000000200000000800002000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000f90118f89b948a59de294816a1d218fd97a4aa6dfd6a2fa65b93f863a0ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3efa0000000000000000000000000c7296d50ddb12de4d2cd8c889a73b98538624f61a00000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000003e8f87994d0df3e320aade6f44fc7adcb2308f90331dbd30be1a009a9af46918f2e52460329a694cdd4cd6d55354ea9b336b88b4dea59914a9a83b8400112aeb9f1d2e0d4ac4f8576718f4bdaa5930d61ebe8b6a788347efcea5a70c100000000000000000000000000000000000000000000000000000000000003e8',
    ],
    blockHeader:
        '0xf90238a034008f8f2cec507d296d0d61ff72bad962ffcdee491e5365204d1bf7e5102981a01dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347940000000000000000000000000000000000000000a000ace191c324185bef452ad7f15b2076890d5a03a079e8d467b6dc4d3466d4e1a03cc845844e6845dcf2d2624e23648655b5b30fad3b6d4e8fb0111cfa542a77f3a04b2e05690d998be6abae4365125e9703a1b4c71b6e05df4deccbf1cddf284405b90100ffffffdffffffffdfffffffffffffffffffffffffeffffffffffffffffffffffeffffffffffffffffffffffffffdffffffffffffffffffffffffffffffffffffffffffffffffffdffffffdfffffffefffffffffffffffffffffffffffffffffffffffffbfffffffffffffffffffffffffffffffffffffffffffffffaffffffddffffffefffffffbfefffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffbffffffffffffffffffffffeffffffffffffffffffffffffffffffffffff7ffffffffffffffffbffffffffffbfffffffff7ffffeffbfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff80833887a68401c9c380840105129684648c754899d883010b04846765746888676f312e32302e32856c696e7578a0e6eb93040a9b34caaec790da7d17b0b84770aeba37fb46e3bc107d62984c4df48800000000000000008181a057c430fd9cceda34a5ce1f0e39fcbc9805b548a18ba3e789750b4a1c63ccd97f',
};
