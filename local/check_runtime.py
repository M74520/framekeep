"""File-based startup check, safe through Windows PowerShell's native argv handling."""
import sys


def main():
    try:
        import PIL
        import rawpy
        import numpy
    except (ImportError, OSError) as error:
        print(f'Image components are not ready: {error}', file=sys.stderr)
        return 1
    print(f'Image components ready: Pillow {PIL.__version__}, NumPy {numpy.__version__}, rawpy {rawpy.__version__}')
    print(f'RAW decoder ready: LibRaw {rawpy.libraw_version}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
