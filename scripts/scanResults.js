const fs = require('fs');
const https = require('https');
const ethers = require('ethers');
const { Tx } = require("leap-core");
const LeapProvider = require("leap-provider");
const { bufferToHex, ripemd160 } = require('ethereumjs-util');

const boothAbi = require('../build/contracts/VotingBooth').abi;
const boxAbi = require('../build/contracts/BallotBox').abi;

/** Params */
const proposalData = 'https://www.npoint.io/documents/217ecb17f01746799a3b';
const proposalsFile = 'build/proposals.json';
const votesFile = 'build/voteTxs.json';
const leapNetworkNode = 'https://testnet-node.leapdao.org';
const startBlock = 87632; 
const endBlock = 91470;
/** ---------------- */

const factor18 = ethers.utils.bigNumberify(String(10 ** 18));

const plasma = new LeapProvider(leapNetworkNode);

const booth = new ethers.utils.Interface(boothAbi);
const voteFuncSig = booth.functions.castBallot.sighash.replace('0x', '');

const box = new ethers.utils.Interface(boxAbi);
const withdrawFuncSig = box.functions.withdraw.sighash.replace('0x', '');

const getFuncSig = tx => 
  tx.inputs[0].msgData.slice(0, 4).toString('hex');

const isSpendie = tx => tx.type === 13;

const isVote = tx => isSpendie(tx) && getFuncSig(tx) === voteFuncSig;

const isWithdraw = tx => isSpendie(tx) && getFuncSig(tx) === withdrawFuncSig;

const slimTx = ({ hash, blockHash, blockNumber, from, to, raw }) => ({
  hash, blockHash, blockNumber, from, to, raw
});

const downloadTxs = async () => {
  let txs = [];
  for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
    txs = txs.concat(
      (await plasma.getBlock(blockNum, true)).transactions.map(slimTx)
    );
    process.stdout.write(`\rDownloading block: ${blockNum}`);
  }
  console.log();
  fs.writeFileSync(`./${votesFile}`, JSON.stringify(txs, null, 2));
  return txs;
};

const getTxData = () => {
  if (fs.existsSync(`./${votesFile}`)) {
    return require(`../${votesFile}`);
  }
  return downloadTxs();
};

const slimProposal = ({ 
  title, proposalId, boothAddress, yesBoxAddress, noBoxAddress
}) => ({
  title, proposalId, boothAddress, yesBoxAddress, noBoxAddress
});

const downloadProposals = async () => {
  return new Promise((resolve, reject) => 
    https.get(proposalData, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve(JSON.parse(raw)));
      res.on('error', e => reject(e));
    })
  );  
};

const getProposals = async () => {
  if (fs.existsSync(`./${proposalsFile}`)) {
    return require(`../${proposalsFile}`);
  }
  
  const rawProps = await downloadProposals();
  const proposals = rawProps.contents.proposals
    .filter(p => p.proposalId)
    .map(slimProposal);

  fs.writeFileSync(`./${proposalsFile}`, JSON.stringify(proposals, null, 2));
  return proposals;
};

// vote is a 4th argument (index 3) to castBallot/withdraw call
const getVotes = (tx) => {
  // cut a func sig
  const msgDataParams = bufferToHex(tx.inputs[0].msgData.slice(4));
  const paramTypes = booth.functions.castBallot.inputs.map(i => i.type);
  
  const params = ethers.utils.defaultAbiCoder.decode(
    paramTypes,
    msgDataParams 
  );
  const votes = params[3].div(factor18).toNumber();
  return isWithdraw(tx) ? -votes : votes;
};

const getProposalByBox = (proposals, boxAddress) =>
  proposals.find((prop) => 
      prop.yesBoxAddress === boxAddress 
      || prop.noBoxAddress === boxAddress
  );

const countByNumberOfVotes = (arr) => 
  arr.reduce((r, v) => {
    r[v[1]] = (r[v[1]] || 0) + 1;
    return r;
  }, {});

const getBoxAddress = (tx, voter) => {
  if (isWithdraw(tx)) {
    return bufferToHex(ripemd160(tx.inputs[0].script));
  }
  return tx.outputs.find(o => o.address !== voter && o.color === 4).address;
};

const getProposalId = (tx, proposals, voter) => {
  const boxAddress = getBoxAddress(tx, voter);
  const { proposalId } = getProposalByBox(proposals, boxAddress) || {};
  if (proposalId) {
    return proposalId;
  }
  console.warn(
    'Unknown proposal vote',
    JSON.stringify({ boxAddress })
  );
};

(async () => {
  const txs = await getTxData();
  const proposals = await getProposals();
  const distr = {};
  const voters = new Set();
  txs.forEach(t => {
    const tx = Tx.fromRaw(t.raw);
    if (isVote(tx) || isWithdraw(tx)) {
      const voter = tx.inputs[1].signer; // balance card signer
      voters.add(voter);
      const proposalId = getProposalId(tx, proposals, voter);
      if (!proposalId) {
        return;
      }
      
      if (!distr[proposalId]) {
        distr[proposalId] = {};
      }
      const proposalVotes = distr[proposalId];

      let votes = getVotes(tx);
      const prevVote = proposalVotes[voter] || 0;
      
      // invert withdrawal value for No Box, so it negates nicely when summed up
      if (prevVote < 0 && isWithdraw(tx)) {
        votes = -votes;
      }
      
      // aggregate votes by the voter for the proposal
      proposalVotes[voter] = (proposalVotes[voter] || 0) + votes;
    }
    return;
  });

  // distr is a Map<proposalId: string, Map<voter: address, vote: number>>
  // groupedDistr is a [{ proposalId:string, distr: Map<vote: number, count: number>}]
  // where `count` is a number of users who put`vote` number of votes for `proposalId`
  const groupedDistr = Object.keys(distr)
    .sort()
    .map((proposalId) => {
      let countByVote = countByNumberOfVotes(Object.entries(distr[proposalId]));
      const totalVotesForProposal = Object.values(countByVote).reduce((r, v) => r +=v, 0);
      countByVote[0] = (countByVote[0] || 0) + voters.size - totalVotesForProposal;
      return { proposalId, distr: countByVote };
    });

  // squash `groupedDistr` with proposal id and dump to CSV
  const distributionByVoteCSV = [`Proposal,Votes,Count`].concat(...groupedDistr.map((v) =>
      Object.entries(v.distr)
        .sort((a, b) => a[0] - b[0])  
        .map(([votes, count]) => `${v.proposalId},${votes},${count}`)
  ));
  
  fs.writeFileSync(`./build/distributionByVote.csv`, distributionByVoteCSV.join('\n'))
  console.log('Distribution by vote saved to:', './build/distributionByVote.csv');  

  console.log("total txs: ", txs.length);
  console.log('voters:', voters.size);
  return;  
})();

