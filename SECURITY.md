# Security

Cubit is a client-side game engine with no server of its own yet, so most
problems will be bugs rather than vulnerabilities. Two areas do matter, because
a game may load data from players or, later, from a network:

- reading snapshots, chunks and maps (`restoreSnapshot`, the chunk codec,
  `decodeSnapshotBinary`, hand-built regions), which should reject malformed
  input rather than crash or misbehave;
- command validation in the simulation, which is what will stop a client from
  doing what it should not once there is a server.

To report a vulnerability, use GitHub's private reporting: the Security tab
of this repository, then "Report a vulnerability". Please do not open a
public issue for it. You should hear back within a week.

Only the latest release is supported with fixes while Cubit is below 1.0.
