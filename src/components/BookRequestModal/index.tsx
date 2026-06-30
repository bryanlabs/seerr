import Modal from '@app/components/Common/Modal';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

interface BookProfile {
  id: number;
  name: string;
}

interface BookRootFolder {
  id: number;
  path: string;
  freeSpace?: number;
}

interface BookTag {
  id: number;
  label: string;
}

interface BookServer {
  id: number;
  name: string;
  isDefault: boolean;
  activeProfileId: number;
  activeMetadataProfileId: number;
  activeDirectory: string;
  activeTags?: number[];
  profiles: BookProfile[];
  metadataProfiles: BookProfile[];
  rootFolders: BookRootFolder[];
  tags: BookTag[];
}

interface ProfilesResponse {
  profiles: BookProfile[];
  metadataProfiles: BookProfile[];
  rootFolders?: BookRootFolder[];
  tags?: BookTag[];
  servers?: BookServer[];
  defaultServerId?: number;
  defaultProfileId: number;
  defaultMetadataProfileId: number;
  defaultRootFolder?: string;
  defaultTags?: number[];
}

interface BookRequestModalProps {
  show: boolean;
  mediaType: 'audiobook' | 'ebook';
  foreignBookId: string;
  authorName?: string;
  title?: string;
  cover?: string;
  onClose: () => void;
  onComplete?: () => void;
}

const BookRequestModal = ({
  show,
  mediaType,
  foreignBookId,
  authorName,
  title,
  cover,
  onClose,
  onComplete,
}: BookRequestModalProps) => {
  const { addToast } = useToasts();
  const apiBase =
    mediaType === 'audiobook' ? '/api/v1/audiobook' : '/api/v1/ebook';
  const { data: profilesData } = useSWR<ProfilesResponse>(
    show ? `${apiBase}/profiles` : null
  );
  const [selectedServer, setSelectedServer] = useState<number | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<number | null>(null);
  const [selectedMetadataProfile, setSelectedMetadataProfile] = useState<
    number | null
  >(null);
  const [selectedRootFolder, setSelectedRootFolder] = useState<string | null>(
    null
  );
  const [selectedTags, setSelectedTags] = useState<number[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!show || !profilesData) return;
    setSelectedServer(profilesData.defaultServerId ?? null);
    setSelectedProfile(profilesData.defaultProfileId ?? null);
    setSelectedMetadataProfile(profilesData.defaultMetadataProfileId ?? null);
    setSelectedRootFolder(profilesData.defaultRootFolder ?? null);
    setSelectedTags(profilesData.defaultTags ?? []);
  }, [profilesData, show]);

  const effectiveServer = useMemo(() => {
    if (!profilesData?.servers?.length) return undefined;
    return (
      profilesData.servers.find((s) => s.id === selectedServer) ??
      profilesData.servers.find((s) => s.isDefault) ??
      profilesData.servers[0]
    );
  }, [profilesData?.servers, selectedServer]);

  const profiles = effectiveServer?.profiles ?? profilesData?.profiles ?? [];
  const metadataProfiles =
    effectiveServer?.metadataProfiles ?? profilesData?.metadataProfiles ?? [];
  const rootFolders =
    effectiveServer?.rootFolders ?? profilesData?.rootFolders ?? [];
  const tags = effectiveServer?.tags ?? profilesData?.tags ?? [];

  const effectiveProfile =
    selectedProfile ?? effectiveServer?.activeProfileId ?? null;
  const effectiveMetadataProfile =
    selectedMetadataProfile ?? effectiveServer?.activeMetadataProfileId ?? null;
  const effectiveRootFolder =
    selectedRootFolder ?? effectiveServer?.activeDirectory ?? null;

  const submit = async () => {
    setSubmitting(true);
    try {
      await axios.post(`${apiBase}/request`, {
        foreignBookId,
        authorName,
        title,
        serverId: effectiveServer?.id,
        profileId: effectiveProfile ?? undefined,
        metadataProfileId: effectiveMetadataProfile ?? undefined,
        rootFolder: effectiveRootFolder ?? undefined,
        tags: selectedTags ?? [],
      });
      addToast(`Requested: ${title ?? 'book'}`, {
        appearance: 'success',
        autoDismiss: true,
      });
      onComplete?.();
      onClose();
    } catch (e) {
      const message =
        (e as { response?: { data?: { message?: string } } }).response?.data
          ?.message ?? 'Request failed';
      addToast(message, { appearance: 'error', autoDismiss: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Transition
      as="div"
      appear
      show={show}
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Modal
        title={`Request ${mediaType === 'audiobook' ? 'Audiobook' : 'Ebook'}`}
        subTitle={title}
        backgroundClickable
        onCancel={onClose}
        onOk={submit}
        okText={submitting ? 'Requesting…' : 'Request'}
        okDisabled={submitting || !profilesData || !effectiveProfile}
        backdrop={cover}
      >
        <div className="flex flex-col gap-4">
          {authorName && (
            <div className="text-sm text-gray-300">
              <span className="text-gray-400">by </span>
              {authorName}
            </div>
          )}
          {profilesData?.servers && profilesData.servers.length > 1 && (
            <div>
              <div className="mb-1 text-sm font-semibold text-gray-200">
                Destination Server
              </div>
              <select
                value={effectiveServer?.id ?? ''}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  const next = profilesData.servers?.find((s) => s.id === id);
                  setSelectedServer(id);
                  setSelectedProfile(next?.activeProfileId ?? null);
                  setSelectedMetadataProfile(
                    next?.activeMetadataProfileId ?? null
                  );
                  setSelectedRootFolder(next?.activeDirectory ?? null);
                  setSelectedTags(next?.activeTags ?? []);
                }}
                className="w-full rounded-md border border-gray-600 bg-gray-800 py-2 pl-3 pr-3 text-sm text-white"
              >
                {profilesData.servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.isDefault ? ' (Default)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <div className="mb-1 text-sm font-semibold text-gray-200">
              Quality Profile
            </div>
            {!profilesData ? (
              <div className="text-xs text-gray-400">Loading profiles…</div>
            ) : (
              <select
                value={effectiveProfile ?? ''}
                onChange={(e) =>
                  setSelectedProfile(
                    e.target.value === '' ? null : Number(e.target.value)
                  )
                }
                className="w-full rounded-md border border-gray-600 bg-gray-800 py-2 pl-3 pr-3 text-sm text-white"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.id === effectiveServer?.activeProfileId
                      ? ' (Default)'
                      : ''}
                  </option>
                ))}
              </select>
            )}
            {mediaType === 'audiobook' && (
              <p className="mt-1 text-xs text-gray-500">
                <strong className="text-gray-300">Spoken (m4b)</strong> only
                allows m4b releases.{' '}
                <strong className="text-gray-300">Spoken (mp3)</strong> allows
                mp3. Most MyAnonamouse releases are mp3.
              </p>
            )}
          </div>
          {metadataProfiles.length > 0 && (
            <div>
              <div className="mb-1 text-sm font-semibold text-gray-200">
                Metadata Profile
              </div>
              <select
                value={effectiveMetadataProfile ?? ''}
                onChange={(e) =>
                  setSelectedMetadataProfile(
                    e.target.value === '' ? null : Number(e.target.value)
                  )
                }
                className="w-full rounded-md border border-gray-600 bg-gray-800 py-2 pl-3 pr-3 text-sm text-white"
              >
                {metadataProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.id === effectiveServer?.activeMetadataProfileId
                      ? ' (Default)'
                      : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {rootFolders.length > 0 && (
            <div>
              <div className="mb-1 text-sm font-semibold text-gray-200">
                Root Folder
              </div>
              <select
                value={effectiveRootFolder ?? ''}
                onChange={(e) => setSelectedRootFolder(e.target.value)}
                className="w-full rounded-md border border-gray-600 bg-gray-800 py-2 pl-3 pr-3 text-sm text-white"
              >
                {rootFolders.map((f) => (
                  <option key={f.id} value={f.path}>
                    {f.path}
                    {f.path === effectiveServer?.activeDirectory
                      ? ' (Default)'
                      : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {tags.length > 0 && (
            <div>
              <div className="mb-1 text-sm font-semibold text-gray-200">
                Tags
              </div>
              <div className="max-h-32 overflow-auto rounded-md border border-gray-700 bg-gray-800 p-2">
                {tags.map((tag) => (
                  <label
                    key={tag.id}
                    className="mb-1 flex items-center gap-2 text-sm text-gray-200 last:mb-0"
                  >
                    <input
                      type="checkbox"
                      checked={(selectedTags ?? []).includes(tag.id)}
                      onChange={(e) => {
                        const current = selectedTags ?? [];
                        setSelectedTags(
                          e.target.checked
                            ? [...current, tag.id]
                            : current.filter((id) => id !== tag.id)
                        );
                      }}
                    />
                    <span>{tag.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {metadataProfiles.length === 0 &&
            profilesData?.metadataProfiles &&
            profilesData.metadataProfiles.length > 0 && (
              <div>
                <div className="mb-1 text-sm font-semibold text-gray-200">
                  Metadata Profile
                </div>
                <div className="text-xs text-gray-400">
                  Using{' '}
                  <span className="text-white">
                    {
                      profilesData.metadataProfiles.find(
                        (p) => p.id === profilesData.defaultMetadataProfileId
                      )?.name
                    }
                  </span>{' '}
                  (server default)
                </div>
              </div>
            )}
        </div>
      </Modal>
    </Transition>
  );
};

export default BookRequestModal;
