# Third-party components

The source ZIP does not embed a Python interpreter or third-party image binaries. The first-run launcher downloads these components into the user's private application directory. Their respective license files remain with the installed distributions.

| Component | Purpose | License / source |
| --- | --- | --- |
| Python 3.12.10, Windows embeddable distribution | Local runtime | Python Software Foundation License; https://www.python.org/downloads/release/python-31210/ |
| pip 25.0.1 | First-run binary installation | MIT; https://pypi.org/project/pip/25.0.1/ |
| Pillow | Image read, EXIF rotation, preview resize | HPND; https://github.com/python-pillow/Pillow |
| rawpy 0.27.1 | On-demand RAW decode | MIT; https://github.com/letmaik/rawpy |
| LibRaw, bundled by rawpy's wheel | Camera RAW support | LGPL 2.1 / CDDL 1.0; https://www.libraw.org/download and https://github.com/LibRaw/LibRaw |
| NumPy, installed as a rawpy dependency | Pixel arrays | BSD 3-Clause; https://github.com/numpy/numpy |

LibRaw's installed version is printed during the Windows startup check (`rawpy.libraw_version`). Sources and licenses for the decoder are available at the links above. The installed wheels contain additional notices for their dependencies; preserve those files if redistributing an installed runtime. This ZIP contains only the application source and a launcher, and contains no third-party photographs.
