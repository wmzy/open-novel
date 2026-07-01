import { useQuery } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  projectId: string;
}

export default function WorldView({ projectId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['novel-file', projectId, 'world'],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent('world-building.md')}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.content as string;
    },
  });

  if (isLoading) return <div>加载中...</div>;
  if (!data) return <div>尚未创建世界观。在聊天面板中输入 /world 开始。</div>;

  return (
    <div>
      <h3>世界观</h3>
      <Markdown remarkPlugins={[remarkGfm]}>{data}</Markdown>
    </div>
  );
}
