import Modal from '@app/components/Common/Modal';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useState } from 'react';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

interface BookProfile {
  id: number;
  name: string;
}

interface ProfilesResponse {
  profiles: BookProfile[];
  metadataProfiles: BookProfile[];
  defaultProfileId: number;
  defaultMetadataProfileId: number;
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
  const [selectedProfile, setSelectedProfile] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const effectiveProfile =
    selectedProfile ?? profilesData?.defaultProfileId ?? null;

  const submit = async () => {
    setSubmitting(true);
    try {
      await axios.post(`${apiBase}/request`, {
        foreignBookId,
        authorName,
        title,
        profileId: effectiveProfile ?? undefined,
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
        okDisabled={submitting || !profilesData}
        backdrop={cover}
      >
        <div className="flex flex-col gap-4">
          {authorName && (
            <div className="text-sm text-gray-300">
              <span className="text-gray-400">by </span>
              {authorName}
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
                {profilesData.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.id === profilesData.defaultProfileId ? ' (Default)' : ''}
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
          {profilesData?.metadataProfiles &&
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
