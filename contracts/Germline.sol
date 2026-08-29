// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title Germline -- heritable, selectable AI agents on 0G
///
/// ERC-7857 gives an agent an identity and a `clone()` primitive, which is
/// reproduction in all but name. Nothing in the ecosystem uses it, because a
/// clone on its own is just a copy: there is no way to tell whether a claimed
/// child really descends from its claimed parent, and no reason for a bad
/// agent not to reproduce forever.
///
/// Germline supplies the two things that turn copying into evolution.
///
/// HEREDITY IS VERIFIABLE. A child's genome is not asserted, it is derived.
/// The mutation seed is fixed by the chain, not the breeder:
///
///     seed = keccak256(parentGenomeRoot, blockhash(requestBlock), parentId, ordinal)
///
/// Reproduction is therefore two steps. `requestSpawn` commits to breeding at
/// a block whose hash does not exist yet; `spawn` reveals the child. Because
/// the seed is only knowable after the commitment, a breeder cannot grind
/// through seeds looking for a flattering mutation. Anyone holding the parent
/// genome can re-run the mutation off-chain and confirm the child root stored
/// here -- so a forged lineage is detectable by arithmetic rather than by
/// trust.
///
/// SELECTION IS ENFORCED. Reproduction is not a right. An organism earns
/// offspring by measured fitness, and a genome that cannot clear the survival
/// threshold leaves no descendants. That rule lives in `spawnAllowance`, and
/// the contract will not mint a child that the parent has not earned.
///
/// Genomes and evaluation transcripts are held on 0G Storage; this contract
/// stores their roots, so the chain carries the lineage and the evidence
/// pointer while the payload stays where payloads belong.
contract Germline is ERC721 {
    // --- selection parameters -------------------------------------------

    /// Fitness is basis points: 10000 is a perfect score.
    uint64 public constant FITNESS_SCALE = 10000;

    /// Below this, an organism is a dead end and leaves no descendants.
    /// Set at the accuracy a trivial baseline reaches, so merely existing
    /// does not qualify as being fit.
    uint64 public immutable survivalThreshold;

    /// Each further step of fitness above the threshold buys one more child.
    uint64 public immutable fecundityStep;

    /// Offspring a merely-viable organism gets. It has to be more than one.
    /// Most mutations are worse than their parent -- that is what mutations
    /// are -- so a line granted a single attempt dies on its first bad roll,
    /// and the population stops climbing before it has started. Several
    /// attempts per parent is not generosity, it is the minimum that lets
    /// selection see a choice.
    uint64 public immutable baseFecundity;

    /// blockhash() only reaches back 256 blocks, so a commitment that is not
    /// used inside that window can no longer be proved and must be remade.
    uint256 public constant SPAWN_WINDOW = 250;

    // --- state -----------------------------------------------------------

    struct Organism {
        uint256 parent; // 0 for a founder
        uint32 generation;
        uint32 offspring;
        uint64 bornAt;
        bytes32 genomeRoot; // 0G Storage root of the genome
        bytes32 mutationSeed; // seed this genome was derived under
        address steward;
        uint256 agenticId; // optional ERC-7857 token this organism embodies
    }

    struct Fitness {
        uint64 score; // basis points
        uint64 attestedAt;
        bytes32 trialId; // which benchmark produced it
        bytes32 evidenceRoot; // 0G Storage root of the transcript
        address attestor;
    }

    uint256 public population;
    mapping(uint256 => Organism) private _organisms;
    mapping(uint256 => Fitness) private _fitness;

    /// Open commitments: organism id => block whose hash will seed the child.
    mapping(uint256 => uint256) public spawnRequestBlock;

    /// Genome roots already claimed, so the same genome cannot be minted twice.
    mapping(bytes32 => bool) public genomeSeen;

    /// Who may attest fitness. Attestation is a measurement, not an opinion,
    /// and every attestation carries an evidence root that anyone can re-run.
    mapping(address => bool) public isAttestor;
    address public curator;

    // --- events ----------------------------------------------------------

    event Founded(uint256 indexed id, bytes32 genomeRoot, address steward);
    event SpawnRequested(uint256 indexed parent, uint256 requestBlock);
    event Spawned(
        uint256 indexed id,
        uint256 indexed parent,
        uint32 generation,
        bytes32 genomeRoot,
        bytes32 mutationSeed
    );
    event FitnessAttested(
        uint256 indexed id,
        uint64 score,
        bytes32 trialId,
        bytes32 evidenceRoot,
        address attestor
    );
    event AgenticIdLinked(uint256 indexed id, uint256 agenticId);
    event AttestorSet(address indexed attestor, bool allowed);

    // --- errors ----------------------------------------------------------

    error NotCurator();
    error NotAttestor();
    error NoSuchOrganism();
    error GenomeAlreadyUsed();
    error NoPendingRequest();
    error TooEarly();
    error RequestExpired();
    error NotSteward();
    error Barren(); // parent has not earned another child
    error ScoreOutOfRange();

    modifier onlyCurator() {
        if (msg.sender != curator) revert NotCurator();
        _;
    }

    constructor(
        uint64 survivalThreshold_,
        uint64 fecundityStep_,
        uint64 baseFecundity_
    ) ERC721("Germline Organism", "GERM") {
        require(fecundityStep_ > 0, "fecundity step must be positive");
        require(baseFecundity_ > 0, "viable organisms must be able to breed");
        require(survivalThreshold_ <= FITNESS_SCALE, "threshold out of range");
        curator = msg.sender;
        isAttestor[msg.sender] = true;
        survivalThreshold = survivalThreshold_;
        fecundityStep = fecundityStep_;
        baseFecundity = baseFecundity_;
    }

    // --- founding --------------------------------------------------------

    /// Introduce a genome with no ancestry. Generation zero.
    function seedFounder(
        bytes32 genomeRoot,
        address steward
    ) external onlyCurator returns (uint256 id) {
        if (genomeRoot == bytes32(0)) revert NoSuchOrganism();
        if (genomeSeen[genomeRoot]) revert GenomeAlreadyUsed();

        id = ++population;
        genomeSeen[genomeRoot] = true;
        _organisms[id] = Organism({
            parent: 0,
            generation: 0,
            offspring: 0,
            bornAt: uint64(block.timestamp),
            genomeRoot: genomeRoot,
            mutationSeed: bytes32(0),
            steward: steward,
            agenticId: 0
        });
        _safeMint(steward, id);
        emit Founded(id, genomeRoot, steward);
    }

    // --- reproduction ----------------------------------------------------

    /// Commit to breeding from `parentId`. The child will be seeded by the
    /// hash of a block that has not been mined yet, so the mutation cannot be
    /// chosen -- only accepted or abandoned.
    function requestSpawn(uint256 parentId) external {
        Organism storage parent = _organisms[parentId];
        if (parent.genomeRoot == bytes32(0)) revert NoSuchOrganism();
        if (ownerOf(parentId) != msg.sender) revert NotSteward();
        if (remainingOffspring(parentId) == 0) revert Barren();

        spawnRequestBlock[parentId] = block.number;
        emit SpawnRequested(parentId, block.number);
    }

    /// Reveal the child. `childGenomeRoot` must be the genome an honest
    /// mutation under `mutationSeedFor(parentId)` produces; the seed is
    /// recorded so that anyone can check the derivation off-chain.
    function spawn(
        uint256 parentId,
        bytes32 childGenomeRoot
    ) external returns (uint256 id) {
        Organism storage parent = _organisms[parentId];
        if (parent.genomeRoot == bytes32(0)) revert NoSuchOrganism();
        if (ownerOf(parentId) != msg.sender) revert NotSteward();
        if (childGenomeRoot == bytes32(0)) revert NoSuchOrganism();
        if (genomeSeen[childGenomeRoot]) revert GenomeAlreadyUsed();
        if (remainingOffspring(parentId) == 0) revert Barren();

        uint256 requestBlock = spawnRequestBlock[parentId];
        if (requestBlock == 0) revert NoPendingRequest();
        if (block.number <= requestBlock) revert TooEarly();
        if (block.number > requestBlock + SPAWN_WINDOW) revert RequestExpired();

        bytes32 seed = _seed(parentId, requestBlock, parent);
        delete spawnRequestBlock[parentId];

        id = ++population;
        genomeSeen[childGenomeRoot] = true;
        uint32 generation = parent.generation + 1;
        parent.offspring += 1;

        _organisms[id] = Organism({
            parent: parentId,
            generation: generation,
            offspring: 0,
            bornAt: uint64(block.timestamp),
            genomeRoot: childGenomeRoot,
            mutationSeed: seed,
            steward: msg.sender,
            agenticId: 0
        });
        _safeMint(msg.sender, id);
        emit Spawned(id, parentId, generation, childGenomeRoot, seed);
    }

    /// The seed a pending commitment will resolve to, once its block is mined.
    /// Reverts while the hash is still unknowable, which is the point.
    function mutationSeedFor(uint256 parentId) external view returns (bytes32) {
        Organism storage parent = _organisms[parentId];
        if (parent.genomeRoot == bytes32(0)) revert NoSuchOrganism();
        uint256 requestBlock = spawnRequestBlock[parentId];
        if (requestBlock == 0) revert NoPendingRequest();
        if (block.number <= requestBlock) revert TooEarly();
        if (block.number > requestBlock + SPAWN_WINDOW) revert RequestExpired();
        return _seed(parentId, requestBlock, parent);
    }

    function _seed(
        uint256 parentId,
        uint256 requestBlock,
        Organism storage parent
    ) private view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    parent.genomeRoot,
                    blockhash(requestBlock),
                    parentId,
                    parent.offspring
                )
            );
    }

    // --- selection -------------------------------------------------------

    /// How many children this organism has earned in total. An unmeasured or
    /// unfit genome earns none: it is a leaf, and its line ends there.
    function spawnAllowance(uint256 id) public view returns (uint256) {
        uint64 score = _fitness[id].score;
        if (score < survivalThreshold) return 0;
        return baseFecundity + (score - survivalThreshold) / fecundityStep;
    }

    function remainingOffspring(uint256 id) public view returns (uint256) {
        uint256 allowed = spawnAllowance(id);
        uint256 had = _organisms[id].offspring;
        return had >= allowed ? 0 : allowed - had;
    }

    /// Record a measured score together with the transcript that produced it.
    /// The evidence root is mandatory: a score without reproducible evidence
    /// is an opinion, and opinions must not move a genome's right to breed.
    function attestFitness(
        uint256 id,
        uint64 score,
        bytes32 trialId,
        bytes32 evidenceRoot
    ) external {
        if (!isAttestor[msg.sender]) revert NotAttestor();
        if (_organisms[id].genomeRoot == bytes32(0)) revert NoSuchOrganism();
        if (score > FITNESS_SCALE) revert ScoreOutOfRange();
        if (evidenceRoot == bytes32(0)) revert NoSuchOrganism();

        _fitness[id] = Fitness({
            score: score,
            attestedAt: uint64(block.timestamp),
            trialId: trialId,
            evidenceRoot: evidenceRoot,
            attestor: msg.sender
        });
        emit FitnessAttested(id, score, trialId, evidenceRoot, msg.sender);
    }

    // --- ERC-7857 linkage ------------------------------------------------

    /// Bind this organism to the Agentic ID that embodies it. Kept as a link
    /// rather than an implementation: re-encrypting metadata on transfer needs
    /// the oracle ERC-7857 specifies, and claiming to do that without one
    /// would be dishonest.
    function linkAgenticId(uint256 id, uint256 agenticId) external {
        if (_organisms[id].genomeRoot == bytes32(0)) revert NoSuchOrganism();
        if (ownerOf(id) != msg.sender) revert NotSteward();
        _organisms[id].agenticId = agenticId;
        emit AgenticIdLinked(id, agenticId);
    }

    // --- reading ---------------------------------------------------------

    function organismOf(uint256 id) external view returns (Organism memory) {
        if (_organisms[id].genomeRoot == bytes32(0)) revert NoSuchOrganism();
        return _organisms[id];
    }

    function fitnessOf(uint256 id) external view returns (Fitness memory) {
        return _fitness[id];
    }

    /// Walk back to the founder. Bounded so a deep line cannot make this
    /// call unservable.
    function lineageOf(
        uint256 id,
        uint256 limit
    ) external view returns (uint256[] memory chain) {
        if (_organisms[id].genomeRoot == bytes32(0)) revert NoSuchOrganism();
        uint256[] memory buffer = new uint256[](limit);
        uint256 n = 0;
        uint256 cursor = id;
        while (cursor != 0 && n < limit) {
            buffer[n++] = cursor;
            cursor = _organisms[cursor].parent;
        }
        chain = new uint256[](n);
        for (uint256 i = 0; i < n; i++) chain[i] = buffer[i];
    }

    // --- administration --------------------------------------------------

    function setAttestor(address who, bool allowed) external onlyCurator {
        isAttestor[who] = allowed;
        emit AttestorSet(who, allowed);
    }

    function transferCuration(address to) external onlyCurator {
        require(to != address(0), "curator cannot be nobody");
        curator = to;
    }
}
