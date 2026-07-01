import { useQuery } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  projectId: string;
}

export default function SceneView({ projectId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['novel-file', projectId, 'scenes'],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent('scenes.md')}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.content as string;
    },
  });

  if (isLoading) return <div>加载中...</div>;
  if (!data) return <div>尚未创建场景。在聊天面板中输入 /scenes 开始。</div>;

  return (
    <div>
      <h3>场景</h3>
      <Markdown remarkPlugins={[remarkGfm]}>{data}</Markdown>
    </div>
  );
}
