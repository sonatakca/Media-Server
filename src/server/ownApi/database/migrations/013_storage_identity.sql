-- Which volume a quarantine was actually recorded against.
--
-- The incident row identified its storage by mount path alone, and a mount path
-- is a location rather than an identity. A disk image containing a partition
-- named `Expansion` was mounted for tests while the failed physical `Expansion`
-- HDD was unplugged; `mount` reported
-- `/dev/disk4s1 on /Volumes/Expansion (exfat)` and every path-based check in the
-- system agreed the dangerous drive was back.
--
-- That is survivable as a false positive. As a false negative it is not: the
-- operator's verification step asked only "does something answer at this path",
-- so attaching *any* volume there — an image, a different disk — would have
-- passed the check and handed back a green light for hardware nobody repaired.
--
-- These columns are what the check compares against.

ALTER TABLE storage_incidents
  -- The volume's own UUID. The single authoritative identity: it survives
  -- unmount, remount and reboot, which is exactly what a device node does not.
  ADD COLUMN volume_uuid varchar(64),
  -- physical-external | physical-internal | disk-image | network | unknown.
  -- A necessary condition, never a sufficient one: "external + exfat" describes
  -- a great many disks and identifies none of them.
  ADD COLUMN volume_medium varchar(32),
  -- Recorded because a reformat is a different volume wearing the same name.
  ADD COLUMN volume_fs_type varchar(32),
  -- `/dev/disk6s1`. DIAGNOSTIC ONLY, and the column comment says so because the
  -- temptation to match on it is the whole reason this migration exists. Disk
  -- numbers are assigned in attachment order: the same drive gets a different
  -- one after a reconnect, and a different drive later gets the old one.
  ADD COLUMN device_node varchar(64),
  -- How the current identity came to be authoritative.
  --
  -- 'probe' means it was read from the volume while that volume was healthy.
  -- 'adopted' means an operator declared replacement storage authoritative
  -- after the original could not be recovered. The two must stay
  -- distinguishable for ever: a page that presented an adoption as a confirmed
  -- recovery of the original hardware would be lying about which disk is in the
  -- machine.
  ADD COLUMN identity_source varchar(16),
  ADD COLUMN adopted_at timestamptz,
  -- The UUID adoption superseded, when there was one. "This drive was replaced
  -- on the 3rd" is what somebody reading the history a year later needs, and it
  -- is the one fact a successful recovery would otherwise erase.
  ADD COLUMN superseded_volume_uuid varchar(64);

COMMENT ON COLUMN storage_incidents.volume_uuid IS
  'Authoritative identity. Recovery requires this to match; a NULL here means the quarantine cannot be satisfied automatically and needs an operator.';
COMMENT ON COLUMN storage_incidents.identity_source IS
  'probe = read from the volume while healthy; adopted = an operator declared replacement storage authoritative. Never conflate the two.';
COMMENT ON COLUMN storage_incidents.device_node IS
  'Diagnostic only. Never sufficient for recovery identity: /dev/diskN is reassigned across reconnects and reboots.';

-- Finding every incident recorded against one physical volume, across however
-- many paths it has been mounted at. Partial because most rows never have one.
CREATE INDEX storage_incidents_volume_uuid_idx
  ON storage_incidents (volume_uuid)
  WHERE volume_uuid IS NOT NULL;

-- Existing rows keep NULL identity, which is deliberate and is the safe
-- direction: an incident recorded before identity existed cannot be matched
-- against anything, so it fails closed and waits for a person rather than being
-- satisfied by whatever happens to be mounted.
